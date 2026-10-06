import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { EgressPolicy } from './egress-policy.js';
import type { RuntimeProcess, SandboxCli } from './sandbox-cli.js';

import { EgressLink } from './egress-link.js';
import { EgressProxy } from './egress-proxy.js';
import { HttpError } from './http-error.js';
import { hostsOf, relayRoute } from './relay-routes.js';
import { KILL_ALL, KILL_TREE, PREPARE } from './sandbox-scripts.js';

/** What every sandbox is made with: the service's to give. */
export interface SandboxSettings {
  /** The Node.js binary the sandbox runs the programs of `in-sandbox/` with: the image's own. */
  node: string;
  /** The directory of those programs, built. */
  helpers: string;
  /** `PATH`, `HOME` and working directory of the sandbox's commands. */
  path: string;
  home: string;
  workingDirectory: string;
  /**
   * Where the egress relay listens in the sandbox. 0 lets it pick a free port: for sandboxes that
   * share a loopback, as the fake CLI's do.
   */
  egressPort: number;
  /**
   * Let the sandbox reach loopback, private and link-local addresses, and plain HTTP base URLs.
   * Never on Cloud Run, where they lead to the metadata server and the service itself: for tests
   * and local runs only.
   */
  allowPrivateNetwork: boolean;
}

/** A sandbox, as the service describes it: where its commands run by default, and its home. */
export interface SandboxDescription {
  name: string;
  home: string;
  workingDirectory: string;
}

/** One command to run in a sandbox. */
export interface Command {
  command: string;
  /** Where it runs: the sandbox's working directory by default. */
  workingDirectory?: string;
  /** Variables of its own, beside those of the sandbox. */
  env?: Record<string, string>;
}

/** A process started in the sandbox. */
export interface SandboxProcess {
  readonly id: string;
  /** What runs it: its streams are the process's. */
  readonly child: RuntimeProcess;
  /** Stops the process in the sandbox, and everything it started. */
  kill(): Promise<void>;
}

/** How many times a process is looked for, 100 ms apart, before giving up on stopping it. */
const KILL_ATTEMPTS = 20;

/** How long the exit code of a process is kept, for a caller that lost its stream. */
const EXITED_KEPT_MS = 10 * 60_000;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The scheme a credential header value may start with, before the secret itself. */
const SCHEME = /^(Bearer|Basic|Token)\s+/i;

/** Shorter values are no secret worth guarding, and would match by chance. */
const MIN_SECRET_LENGTH = 12;

/**
 * One running sandbox: its commands, its way out, its ports.
 *
 * Every command runs with no variable but those of {@link environment} and its own. The sandbox
 * has no network of its own: its egress relay, a program started in it, carries its connections
 * over its standard streams to an {@link EgressProxy} of the service, which lets out what the
 * policy allows and puts the credentials in. A port of the sandbox is reached the same way,
 * through the `connect` program.
 */
export class Sandbox implements EgressPolicy {
  allowedHosts: readonly string[] = [];
  /** Variables pointed at the relay, and where they really lead. */
  baseUrls: Readonly<Record<string, string>> = {};
  transformations: HarnessV1RequestTransformation[] = [];
  private readonly processes = new Map<string, SandboxProcess>();
  private readonly proxy = new EgressProxy(() => this);
  private relay?: RuntimeProcess;
  /** The port the egress relay listens on, once it does. */
  private relayPort?: number;
  private relayStarting?: Promise<void>;

  constructor(
    readonly name: string,
    private readonly settings: SandboxSettings,
    private readonly cli: SandboxCli,
  ) {}

  get upstreamHosts(): readonly string[] {
    return hostsOf(this.baseUrls);
  }

  get allowPrivateNetwork(): boolean {
    return this.settings.allowPrivateNetwork;
  }

  /** The secrets the service holds for the sandbox: what its transformations put in requests. */
  private get secrets(): string[] {
    return this.transformations
      .flatMap(({ transform }) => Object.values(transform.headers))
      .map((value) => value.replace(SCHEME, ''))
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  }

  /** Where the processes started in the sandbox leave their pids. */
  private get processDirectory(): string {
    return join(this.stateDirectory, 'processes');
  }

  /** What the service keeps in the sandbox: pids. Emptied whenever the sandbox starts. */
  private get stateDirectory(): string {
    return join(this.settings.home, '.ai-sdk-sandbox');
  }

  private get relayOrigin(): string {
    return `http://127.0.0.1:${this.relayPort ?? this.settings.egressPort}`;
  }

  describe(): SandboxDescription {
    const { home, workingDirectory } = this.settings;
    return { name: this.name, home, workingDirectory };
  }

  /**
   * The variables a command runs with: the sandbox's, its base URLs routed through the relay, then
   * the command's own. A command's own value for a base URL variable is routed too: a harness that
   * points its client at the real API still goes through the relay.
   */
  environment(env: Readonly<Record<string, string>> = {}): Record<string, string> {
    const origin = this.relayOrigin;
    const route = (url: string): string => relayRoute(url, origin) ?? url;
    const variables: Record<string, string> = {
      PATH: this.settings.path,
      HOME: this.settings.home,
      LANG: 'C.UTF-8',
      // Everything else leaves through the relay as a proxy: package managers and Node.js read these.
      HTTPS_PROXY: origin,
      HTTP_PROXY: origin,
      https_proxy: origin,
      http_proxy: origin,
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      // A Cloud Run sandbox runs its commands as root: tell the agents it is a sandbox all the same.
      IS_SANDBOX: '1',
      // pnpm copies a package a postinstall script changed back to its store: in a Cloud Run
      // sandbox, that kills the sandbox (the Claude Code bridge's install did, every time).
      npm_config_side_effects_cache: 'false',
    };
    for (const [name, url] of Object.entries(this.baseUrls)) variables[name] = route(url);
    for (const [name, value] of Object.entries(env)) {
      variables[name] = name in this.baseUrls ? route(value) : value;
    }
    return variables;
  }

  /** Starts the sandbox, its writable layer the tar at `layer` when given. */
  create(layer?: string): Promise<void> {
    return this.cli.create(this.name, layer);
  }

  /** Makes the home and working directory of the started sandbox, and opens its way out. */
  async prepare(): Promise<void> {
    const { home, workingDirectory } = this.settings;
    await this.untracked(
      PREPARE,
      home,
      workingDirectory,
      this.stateDirectory,
      this.processDirectory,
    );
    await this.startRelay();
  }

  /**
   * Starts `command`; its standard input is the caller's to write and end. The process outlives
   * whoever started it, a request Cloud Run cut say: it is found again by its id until a while
   * after it exits, and stopped only by {@link SandboxProcess.kill}.
   */
  exec({ command, workingDirectory, env = {} }: Command): SandboxProcess {
    const id = randomUUID();
    const pidFile = join(this.processDirectory, id);
    const directory = workingDirectory ?? this.settings.workingDirectory;
    const child = this.spawn(['/bin/sh', '-c', command], env, { cwd: directory, pidFile });
    let exited = false;
    void child.exited.then(() => (exited = true));
    const kill = async (): Promise<void> => {
      // A process killed as soon as it starts may not have recorded its pid yet.
      for (let attempt = 0; attempt < KILL_ATTEMPTS && !exited; attempt++) {
        if (
          await this.untracked(KILL_TREE, pidFile).then(
            () => true,
            () => false,
          )
        )
          break;
        await sleep(100);
      }
      child.kill();
    };
    const started = { id, child, kill };
    this.processes.set(id, started);
    void child.exited.then(() =>
      setTimeout(() => this.processes.delete(id), EXITED_KEPT_MS).unref(),
    );
    return started;
  }

  /** A process {@link exec} started, while it runs and for a while after it exits. */
  process(id: string): SandboxProcess | undefined {
    return this.processes.get(id);
  }

  /** Stops every process started in the sandbox, by this service or a previous instance of it. */
  async killAll(): Promise<void> {
    await this.untracked(KILL_ALL, this.processDirectory);
  }

  /** Opens a connection to `port` of the sandbox's loopback, through the `connect` program. */
  connect(port: number): RuntimeProcess {
    return this.spawn([
      this.settings.node,
      join(this.settings.helpers, 'connect.js'),
      String(port),
    ]);
  }

  /** Writes the sandbox's writable layer to `path`, a file or a pipe, as a tar. */
  snapshot(path: string): Promise<void> {
    return this.cli.snapshot(this.name, path);
  }

  /** Deletes the sandbox, and everything it runs with it. */
  async delete(): Promise<void> {
    const relay = this.relay;
    if (relay !== undefined) {
      relay.kill();
      await relay.exited;
    }
    this.proxy.close();
    await this.cli.delete(this.name);
  }

  /** Starts the egress relay unless it runs: a relay that died is started again. */
  startRelay(): Promise<void> {
    if (this.relay !== undefined) return Promise.resolve();
    this.relayStarting ??= this.spawnRelay().finally(() => (this.relayStarting = undefined));
    return this.relayStarting;
  }

  private async spawnRelay(): Promise<void> {
    const pidFile = join(this.stateDirectory, 'egress-relay.pid');
    // A relay whose `sandbox exec` died may live on in the sandbox, holding the port.
    await this.untracked(KILL_TREE, pidFile).catch(() => undefined);
    const relay = this.spawn(
      [
        this.settings.node,
        join(this.settings.helpers, 'egress-relay.js'),
        String(this.settings.egressPort),
      ],
      {},
      { pidFile },
    );
    this.relay = relay;
    void relay.exited.then(() => {
      if (this.relay === relay) this.relay = undefined;
    });
    const link = new EgressLink(relay, await this.proxy.port());
    // Nothing runs in the sandbox before its way out is open.
    this.relayPort = await link.listening;
  }

  /** Runs `script` to completion with `args`, its pid not recorded; throws unless it succeeds. */
  private async untracked(script: string, ...args: string[]): Promise<void> {
    const child = this.spawn(['/bin/sh', '-c', script, ...args]);
    child.stdin.end();
    child.stdout.resume();
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const code = await child.exited;
    if (code !== 0) {
      const reason = Buffer.concat(stderr).toString().trim();
      throw new Error(`A command failed in ${this.name} (${code}): ${reason}`);
    }
  }

  /**
   * Refuses a command that would carry into the sandbox one of the credentials the service holds
   * for it, on its command line or in its variables: they belong outside the sandbox, where the
   * agent cannot read them. A harness never does that; a mistake would.
   */
  private assertNoSecret(texts: readonly string[]): void {
    const secrets = this.secrets;
    if (secrets.some((secret) => texts.some((text) => text.includes(secret)))) {
      throw new HttpError(
        400,
        'A credential the service holds for this sandbox was about to enter it: refused. Credentials stay outside the sandbox.',
      );
    }
  }

  /**
   * Starts `argv` in the sandbox, under {@link environment} and `env` alone, through the `launch`
   * program. Cloud Run logs the command line of everything it runs in a sandbox: the program, its
   * variables and its directory go on the standard input instead, so none of them is ever logged.
   */
  private spawn(
    argv: string[],
    env: Record<string, string> = {},
    launch: { cwd?: string; pidFile?: string } = {},
  ): RuntimeProcess {
    const variables = this.environment(env);
    const invalid = Object.keys(variables).find((name) => !VARIABLE.test(name));
    if (invalid !== undefined) throw new HttpError(400, `Invalid variable name: ${invalid}`);
    this.assertNoSecret([...argv, ...Object.values(variables)]);
    const child = this.cli.exec(this.name, [
      this.settings.node,
      join(this.settings.helpers, 'launch.js'),
    ]);
    child.stdin.write(`${JSON.stringify({ argv, env: variables, ...launch })}\n`);
    return child;
  }
}
