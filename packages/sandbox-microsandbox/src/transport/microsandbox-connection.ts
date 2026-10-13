import type { ExecHandle, ModifyOptions, Sandbox, SandboxModificationPlan } from 'microsandbox';

import { Sandbox as Sandboxes, SandboxNotFoundError, SandboxNotRunningError } from 'microsandbox';

import { MicrosandboxCommandError } from '../errors/microsandbox-command-error.js';
import { MicrosandboxSandboxNotFoundError } from '../errors/microsandbox-sandbox-not-found-error.js';
import {
  AWAIT_DOCKER,
  DOCKER_LOG,
  DOCKER_MARKER,
  EXISTS,
  START_DOCKER,
} from './sandbox-scripts.js';

type ExecBuilder = Parameters<Parameters<Sandbox['execStreamWith']>[1]>[0];
type SandboxHandle = Awaited<ReturnType<typeof Sandboxes.get>>;

/** The part of a sandbox's configuration this package reads; the SDK types it loosely. */
interface SandboxConfig {
  network?: {
    ports?: { guestPort: number; hostPort: number; protocol: string }[];
    /** The secrets and what a request breaking their rules gets, not the list alone. */
    secrets?: { secrets?: { envVar: string }[] };
  };
}

/** A port of the sandbox published on this host's loopback. */
export interface PortBinding {
  readonly guestPort: number;
  readonly hostPort: number;
}

export interface ExecOptions {
  /** Absolute directory of the sandbox the command starts in. */
  cwd?: string;
  /**
   * Variables of the command, on top of the sandbox's own. They travel to the sandbox with the
   * command, on microsandbox's own channel: never on a command line of this host or the sandbox.
   */
  env?: Record<string, string>;
  /** Written to the command's stdin, which is then closed. */
  stdin?: Uint8Array;
  /** Who the command runs as, instead of the sandbox's user. */
  user?: string;
}

/** A command running in the sandbox. */
export interface SandboxExecution {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with its exit status, 137 when it was killed. */
  wait(): Promise<{ exitCode: number }>;
  /** Kills it and every process it started. */
  kill(): Promise<void>;
}

/** What a finished command left behind. */
export interface SandboxResult {
  exitCode: number;
  /** Kept as bytes: `cat` hands back a file, which need not be text. */
  stdout: Uint8Array;
  stderr: string;
}

/** The exit status microsandbox reports for a killed command, and the one this package reports. */
const KILLED = -1;
const SIGKILL_STATUS = 137;

/** What a sandbox may be in when there is nothing to stop. */
const STOPPED = new Set(['crashed', 'created', 'stopped']);

/**
 * The connection to one microsandbox, through the `microsandbox` SDK: the only way this package
 * reaches a sandbox. Commands go to the sandbox's agent with their arguments as an array, never
 * through a shell of this host.
 *
 * The sandbox runs detached: it outlives this process, and a stopped one is started again by the
 * next command.
 */
export class MicrosandboxConnection {
  /** The connection to the running sandbox, shared by the commands that need it at once. */
  private sandbox: Promise<Sandbox> | undefined;
  /** Whether the sandbox runs a Docker daemon, known once it was started or connected to. */
  private docker: boolean | undefined;

  constructor(
    readonly name: string,
    sandbox?: Sandbox,
  ) {
    this.sandbox = sandbox === undefined ? undefined : Promise.resolve(sandbox);
  }

  /** Starts `argv` in the sandbox and hands back its output as it comes. */
  async start(argv: readonly string[], options: ExecOptions = {}): Promise<SandboxExecution> {
    try {
      return await startOn(await this.live(), argv, options);
    } catch (error) {
      // Stopped from elsewhere since the last command: start it again, once.
      if (!(error instanceof SandboxNotRunningError)) throw error;
      this.sandbox = undefined;
      return startOn(await this.live(), argv, options);
    }
  }

  /** Runs `argv` in the sandbox to completion, whatever its exit status. */
  async run(argv: readonly string[], options: ExecOptions = {}): Promise<SandboxResult> {
    return completion(await this.start(argv, options));
  }

  /** Runs `argv` and returns its output as text, throwing {@link MicrosandboxCommandError} on failure. */
  async check(argv: readonly string[], options: ExecOptions = {}): Promise<string> {
    const result = await this.run(argv, options);
    if (result.exitCode !== 0) throw new MicrosandboxCommandError(argv, result);
    return Buffer.from(result.stdout).toString();
  }

  /**
   * Plans and applies a change to the sandbox's configuration: its secrets, for this package. A
   * restart stops what the sandbox ran in the background: it is started again.
   */
  async modify(options: ModifyOptions): Promise<SandboxModificationPlan> {
    const sandbox = await this.live();
    const plan = await sandbox.modify(options);
    if (options.policy === 'restart') await this.startServices(sandbox);
    return plan;
  }

  /**
   * Starts the Docker daemon of a sandbox made with Docker, unless it runs, and waits for it to
   * answer; does nothing in any other sandbox. A sandbox stops its daemon whenever it stops or
   * restarts: every connection to it, and every restart, starts it again.
   */
  async startServices(sandbox?: Sandbox): Promise<void> {
    const running = sandbox ?? (await this.live());
    const marker = await completion(await startOn(running, ['sh', '-c', EXISTS, DOCKER_MARKER]));
    this.docker = marker.exitCode === 0;
    if (!this.docker) return;
    // A job of microsandbox's: it outlives this process, unlike a command.
    await running.execDetachedWith('sh', (exec) =>
      exec.args(['-c', START_DOCKER, DOCKER_MARKER, DOCKER_LOG]).user('root').stdinNull(),
    );
    const awaiting = ['sh', '-c', AWAIT_DOCKER, DOCKER_LOG];
    const ready = await completion(await startOn(running, awaiting, { user: 'root' }));
    if (ready.exitCode !== 0) throw new MicrosandboxCommandError(awaiting, ready);
  }

  /** Whether the sandbox runs a Docker daemon. */
  async runsDocker(): Promise<boolean> {
    if (this.docker === undefined) await this.live();
    return this.docker ?? false;
  }

  /** The names of the secrets the sandbox holds. */
  async secretNames(): Promise<string[]> {
    const { network } = (await this.handle()).config() as SandboxConfig;
    return (network?.secrets?.secrets ?? []).map(({ envVar }) => envVar);
  }

  /** The TCP ports published when the sandbox was created. */
  async publishedPorts(): Promise<PortBinding[]> {
    const { network } = (await (await this.live()).config()) as SandboxConfig;
    return (network?.ports ?? [])
      .filter(({ protocol }) => protocol === 'tcp')
      .map(({ guestPort, hostPort }) => ({ guestPort, hostPort }));
  }

  /** Stops the sandbox, keeping its disk: the next command starts it again. Idempotent. */
  async stop(): Promise<void> {
    const sandbox = await this.sandbox?.catch(() => undefined);
    this.sandbox = undefined;
    const handle = await this.handle().catch(ignoreNotFound);
    if (handle === undefined || STOPPED.has(handle.status)) return;
    await (sandbox ?? handle).stop();
  }

  /** Stops and removes the sandbox, its disk and its secrets. Idempotent. */
  async destroy(): Promise<void> {
    this.sandbox = undefined;
    await (await this.handle().catch(ignoreNotFound))?.destroy();
  }

  /** The running sandbox, started or reconnected to when needed. */
  private live(): Promise<Sandbox> {
    if (this.sandbox === undefined) {
      const connecting = this.handle()
        .then((handle) => handle.connectOrStart({ detached: true }))
        .then(async (sandbox) => {
          await this.startServices(sandbox);
          return sandbox;
        });
      this.sandbox = connecting;
      // A failed connection is not remembered: the next command tries again.
      connecting.catch(() => {
        if (this.sandbox === connecting) this.sandbox = undefined;
      });
    }
    return this.sandbox;
  }

  private async handle(): Promise<SandboxHandle> {
    try {
      return await Sandboxes.get(this.name);
    } catch (error) {
      if (error instanceof SandboxNotFoundError)
        throw new MicrosandboxSandboxNotFoundError(this.name);
      throw error;
    }
  }
}

/** Starts `argv` in `sandbox` and hands back its output as it comes. */
async function startOn(
  sandbox: Sandbox,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<SandboxExecution> {
  const [command = 'sh', ...args] = argv;
  const handle: ExecHandle = await sandbox.execStreamWith(command, (exec: ExecBuilder) => {
    exec.args([...args]);
    if (options.cwd !== undefined) exec.cwd(options.cwd);
    if (options.env !== undefined) exec.envs(options.env);
    if (options.user !== undefined) exec.user(options.user);
    return options.stdin === undefined
      ? exec.stdinNull()
      : exec.stdinBytes(Buffer.from(options.stdin));
  });
  return execution(handle);
}

/** What `running` left behind once it exited. */
async function completion(running: SandboxExecution): Promise<SandboxResult> {
  const [stdout, stderr, { exitCode }] = await Promise.all([
    new Response(running.stdout).arrayBuffer().then((bytes) => new Uint8Array(bytes)),
    new Response(running.stderr).text(),
    running.wait(),
  ]);
  return { exitCode, stdout, stderr };
}

function ignoreNotFound(error: unknown): undefined {
  if (error instanceof MicrosandboxSandboxNotFoundError) return undefined;
  throw error;
}

/** The events of `handle`, as the streams and the exit status of a process. */
function execution(handle: ExecHandle): SandboxExecution {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start: (controller) => void (out = controller) });
  const stderr = new ReadableStream<Uint8Array>({ start: (controller) => void (err = controller) });
  // A reader that gave up on a stream must not stop the other one.
  const push = (controller: ReadableStreamDefaultController<Uint8Array>, data: Uint8Array) => {
    try {
      controller.enqueue(new Uint8Array(data));
    } catch {
      // Cancelled by its reader.
    }
  };
  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      controller.close();
    } catch {
      // Cancelled by its reader.
    }
  };

  const exited = (async () => {
    let code: number | undefined;
    try {
      for (let event = await handle.recv(); event !== null; event = await handle.recv()) {
        if (event.kind === 'stdout') push(out, event.data);
        else if (event.kind === 'stderr') push(err, event.data);
        else if (event.kind === 'exited') code = event.code;
      }
      code ??= (await handle.wait()).code;
    } finally {
      close(out);
      close(err);
    }
    return { exitCode: code === KILLED ? SIGKILL_STATUS : code };
  })();
  // `wait()` may never be called; an unobserved rejection must not take the process down.
  exited.catch(() => undefined);

  let killed: Promise<void> | undefined;
  return {
    stdout,
    stderr,
    wait: () => exited,
    // Killing a process that already exited is a no-op, not an error.
    kill: () => (killed ??= handle.kill().catch(() => undefined)),
  };
}
