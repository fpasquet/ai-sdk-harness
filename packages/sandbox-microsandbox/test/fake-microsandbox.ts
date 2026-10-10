/* eslint-disable max-classes-per-file -- a stand-in for the classes of a whole SDK */
/**
 * A stand-in for the `microsandbox` SDK, which the unit tests resolve instead of the real one: the
 * part of its API this package uses, over sandboxes that are directories of this host. Commands run
 * on the host, in the sandbox's directory, and isolate nothing. Guest paths are mapped into that
 * directory: the working directory, and every absolute argument after a `sh -c` script.
 *
 * `fake` holds the state the tests set up and inspect.
 */
import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Action = 'allow' | 'deny';
type Policy = { defaultEgress: Action; defaultIngress: Action; rules: unknown[] };

export class MicrosandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class SandboxNotFoundError extends MicrosandboxError {
  constructor(name: string) {
    super('sandboxNotFound', `sandbox not found: ${name}`);
  }
}
export class SandboxAlreadyExistsError extends MicrosandboxError {
  constructor(name: string) {
    super('sandboxAlreadyExists', `sandbox already exists: ${name}`);
  }
}
export class SandboxNotRunningError extends MicrosandboxError {
  constructor(name: string) {
    super('sandboxNotRunning', `sandbox not running: ${name}`);
  }
}
export class RuntimeError extends MicrosandboxError {
  constructor(message: string) {
    super('runtime', `runtime error: ${message}`);
  }
}
export class CustomError extends MicrosandboxError {
  constructor(message: string) {
    super('custom', message);
  }
}

export interface FakeSecret {
  value: string;
  placeholder: string;
  allowedHosts: string[];
}

export interface FakeExec {
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  user?: string;
  stdin?: string;
}

export interface FakeSandbox {
  name: string;
  /** The directory of this host that stands for the sandbox's filesystem. */
  root: string;
  status: 'running' | 'stopped';
  image?: string;
  snapshot?: string;
  cpus?: number;
  memory?: number;
  user?: string;
  detached: boolean;
  interceptTls: boolean;
  ports: { hostPort: number; guestPort: number }[];
  mounts: Record<string, string>;
  networkPolicy?: Policy;
  secrets: Map<string, FakeSecret>;
  /** Bumped by every start: a connection to an earlier one is no longer running. */
  generation: number;
  /** How many times a stopped sandbox was started again. */
  starts: number;
  restarts: number;
  execs: FakeExec[];
  running: Set<ChildProcess>;
}

export interface FakeSnapshot {
  name: string;
  group: string;
  reference: string;
  from: string;
}

const temporary: string[] = [];
const sandboxes = new Map<string, FakeSandbox>();
const snapshots = new Map<string, FakeSnapshot>();
/** Calls that fail, by name (`create`, `restore`, `snapshot`, `connect`…). */
const failures = new Map<string, Error>();
let stubs: string | undefined;

/** A directory of commands the fake shadows on the host: `chown`, which needs root. */
function stubDirectory(): string {
  if (stubs === undefined) {
    stubs = mkdtempSync(join(tmpdir(), 'fake-microsandbox-bin-'));
    temporary.push(stubs);
    writeFileSync(join(stubs, 'chown'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(stubs, 'chown'), 0o755);
  }
  return stubs;
}

function failIfAsked(call: string): void {
  const failure = failures.get(call);
  if (failure !== undefined) throw failure;
}

/** The state of the fake, for the tests. */
export const fake = {
  sandboxes,
  failures,
  snapshots,
  sandbox(name: string): FakeSandbox {
    const sandbox = sandboxes.get(name);
    if (sandbox === undefined) throw new Error(`No fake sandbox named ${name}`);
    return sandbox;
  },
  /** Makes every later `call` fail with `error`. */
  fail(call: string, error: Error = new MicrosandboxError('custom', `${call} failed`)): void {
    failures.set(call, error);
  },
  /** Adds a running sandbox, as if an earlier process had created it. */
  addSandbox(name: string, settings: Partial<FakeSandbox> = {}): FakeSandbox {
    const sandbox = newSandbox(name, settings);
    sandboxes.set(name, sandbox);
    return sandbox;
  },
  reset(): void {
    for (const sandbox of sandboxes.values()) killAll(sandbox);
    sandboxes.clear();
    snapshots.clear();
    failures.clear();
    for (const directory of temporary.splice(0))
      rmSync(directory, { recursive: true, force: true });
    stubs = undefined;
  },
};

function newSandbox(name: string, settings: Partial<FakeSandbox>): FakeSandbox {
  const root = mkdtempSync(join(tmpdir(), 'fake-microsandbox-'));
  temporary.push(root);
  mkdirSync(join(root, 'root'));
  return {
    name,
    root,
    status: 'running',
    detached: false,
    interceptTls: false,
    ports: [],
    mounts: {},
    secrets: new Map(),
    generation: 1,
    starts: 0,
    restarts: 0,
    execs: [],
    running: new Set(),
    ...settings,
  };
}

function killAll(sandbox: FakeSandbox): void {
  for (const child of sandbox.running) {
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  sandbox.running.clear();
}

/** The path of the host a guest path stands for. */
const hostPath = (sandbox: FakeSandbox, path: string): string => join(sandbox.root, path);

type ExecEvent =
  | { code: number; kind: 'exited' }
  | { data: Uint8Array; kind: 'stderr' | 'stdout' }
  | { kind: 'started'; pid: number };

class ExecOptionsBuilder {
  options: Omit<FakeExec, 'argv'> & { args: string[]; stdinBytes?: Buffer } = {
    args: [],
    env: {},
  };
  args(args: string[]): this {
    this.options.args = args;
    return this;
  }
  cwd(cwd: string): this {
    this.options.cwd = cwd;
    return this;
  }
  envs(env: Record<string, string>): this {
    Object.assign(this.options.env, env);
    return this;
  }
  user(user: string): this {
    this.options.user = user;
    return this;
  }
  stdinNull(): this {
    return this;
  }
  stdinBytes(data: Buffer): this {
    this.options.stdinBytes = data;
    return this;
  }
}

export class ExecHandle {
  private readonly events: ExecEvent[] = [];
  private readonly waiting: ((event: Error | ExecEvent | null) => void)[] = [];
  private ended: Error | null | undefined;
  private readonly exit: Promise<{ code: number; success: boolean }>;

  constructor(
    private readonly child: ChildProcess,
    sandbox: FakeSandbox,
  ) {
    this.push({ kind: 'started', pid: child.pid ?? 0 });
    child.stdout?.on('data', (data: Buffer) => this.push({ kind: 'stdout', data }));
    child.stderr?.on('data', (data: Buffer) => this.push({ kind: 'stderr', data }));
    this.exit = new Promise((resolve, reject) => {
      child.once('close', (code, signal) => {
        sandbox.running.delete(child);
        if (this.killed || code !== null) {
          const status = this.killed ? -1 : (code ?? -1);
          this.push({ kind: 'exited', code: status });
          this.end(null);
          resolve({ code: status, success: status === 0 });
        } else {
          // Killed from outside, by a restart of its sandbox.
          const error = new RuntimeError(`exec session ended without exit event (${signal})`);
          this.end(error);
          reject(error);
        }
      });
    });
    this.exit.catch(() => undefined);
  }

  private killed = false;

  private push(event: ExecEvent): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }

  private end(error: Error | null): void {
    this.ended = error;
    for (const waiter of this.waiting.splice(0)) waiter(error);
  }

  recv(): Promise<ExecEvent | null> {
    const event = this.events.shift();
    if (event !== undefined) return Promise.resolve(event);
    if (this.ended !== undefined) {
      return this.ended === null ? Promise.resolve(null) : Promise.reject(this.ended);
    }
    return new Promise((resolve, reject) =>
      this.waiting.push((next) => (next instanceof Error ? reject(next) : resolve(next))),
    );
  }

  wait(): Promise<{ code: number; success: boolean }> {
    return this.exit;
  }

  kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new RuntimeError('process already exited'));
    }
    this.killed = true;
    process.kill(-(this.child.pid ?? 0), 'SIGKILL');
    return Promise.resolve();
  }
}

/** The network configuration as `config()` returns it. */
function networkConfig(sandbox: FakeSandbox, withSecrets: boolean) {
  return {
    network: {
      ports: [
        ...sandbox.ports.map((port) => ({ ...port, protocol: 'tcp', hostBind: '127.0.0.1' })),
        // microsandbox also publishes UDP ports; this package ignores them.
        { hostPort: 5353, guestPort: 53, protocol: 'udp', hostBind: '127.0.0.1' },
      ],
      ...(withSecrets
        ? { secrets: [...sandbox.secrets.keys()].map((envVar) => ({ envVar })) }
        : {}),
    },
  };
}

interface SecretSpec {
  value?: string;
  placeholder?: string;
  allowedHosts?: string[];
}

interface ModifyOptions {
  secrets?: Record<string, SecretSpec>;
  secretsRemove?: string[];
  policy?: 'next_start' | 'no_restart' | 'restart';
}

interface Change {
  name: string;
  change: string;
  disposition: string;
}

/** A secret with a new placeholder needs a restart, and so does turning TLS interception on. */
function secretChange(sandbox: FakeSandbox, name: string, spec: SecretSpec): Change {
  const held = sandbox.secrets.get(name);
  if (held === undefined) return { name, change: 'added', disposition: 'requires restart' };
  if (held.placeholder !== spec.placeholder) {
    return { name, change: 'placeholder updated', disposition: 'requires restart' };
  }
  return { name, change: 'rotated', disposition: 'live' };
}

function apply(sandbox: FakeSandbox, options: ModifyOptions, restart: boolean): void {
  if (restart) {
    killAll(sandbox);
    sandbox.restarts += 1;
    sandbox.interceptTls = true;
  }
  for (const [name, { value = '', placeholder = '', allowedHosts = [] }] of Object.entries(
    options.secrets ?? {},
  )) {
    sandbox.secrets.set(name, { value, placeholder, allowedHosts });
  }
  for (const name of options.secretsRemove ?? []) sandbox.secrets.delete(name);
}

function plan(sandbox: FakeSandbox, options: ModifyOptions): Change[] {
  const secrets = Object.entries(options.secrets ?? {});
  return [
    ...secrets.map(([name, spec]) => secretChange(sandbox, name, spec)),
    ...(secrets.length > 0 && !sandbox.interceptTls
      ? [{ name: 'tls', change: 'updated', disposition: 'requires restart' }]
      : []),
    ...(options.secretsRemove ?? [])
      .filter((name) => sandbox.secrets.has(name))
      .map((name) => ({ name, change: 'removed', disposition: 'live' })),
  ];
}

export class Sandbox {
  private readonly generation: number;

  constructor(private readonly state: FakeSandbox) {
    this.generation = state.generation;
  }

  get name(): string {
    return this.state.name;
  }

  static builder(name: string): SandboxBuilder {
    return new SandboxBuilder(name);
  }

  static restore(snapshot: string): RestoreBuilder {
    return new RestoreBuilder(snapshot);
  }

  static get(name: string): Promise<SandboxHandle> {
    const sandbox = sandboxes.get(name);
    return sandbox === undefined
      ? Promise.reject(new SandboxNotFoundError(name))
      : Promise.resolve(new SandboxHandle(sandbox));
  }

  execStreamWith(
    command: string,
    configure: (builder: ExecOptionsBuilder) => ExecOptionsBuilder,
  ): Promise<ExecHandle> {
    const sandbox = this.state;
    if (sandbox.status !== 'running' || sandbox.generation !== this.generation) {
      return Promise.reject(new SandboxNotRunningError(sandbox.name));
    }
    const { args, cwd, env, user, stdinBytes } = configure(new ExecOptionsBuilder()).options;
    sandbox.execs.push({
      argv: [command, ...args],
      cwd,
      env,
      user,
      stdin: stdinBytes?.toString(),
    });
    // After `-c SCRIPT`, positional arguments that are guest paths are mapped into the root.
    const mapped = args.map((arg, index) =>
      index >= 2 && arg.startsWith('/') ? hostPath(sandbox, arg) : arg,
    );
    const child = spawn(command, mapped, {
      cwd: hostPath(sandbox, cwd ?? '/'),
      env: {
        PATH: `${stubDirectory()}:${process.env.PATH ?? ''}`,
        HOME: hostPath(sandbox, '/root'),
        ...env,
      },
      detached: true,
      stdio: 'pipe',
    });
    sandbox.running.add(child);
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinBytes);
    const handle = new ExecHandle(child, sandbox);
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(handle));
      child.once('error', reject);
    });
  }

  config(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      failIfAsked('config');
      resolve(networkConfig(this.state, false));
    });
  }

  modify(options: ModifyOptions): Promise<{ applied: boolean; changes: Change[] }> {
    const sandbox = this.state;
    const changes = plan(sandbox, options);
    const restart = changes.some(({ disposition }) => disposition !== 'live');
    if (restart && options.policy !== 'restart') {
      return Promise.reject(
        new CustomError(`cannot apply modification: ${changes[0]?.name ?? ''} requires restart`),
      );
    }
    apply(sandbox, options, restart);
    return Promise.resolve({ applied: true, changes });
  }

  stop(): Promise<void> {
    if (this.state.status !== 'running' || this.state.generation !== this.generation) {
      return Promise.reject(new SandboxNotRunningError(this.state.name));
    }
    stop(this.state);
    return Promise.resolve();
  }
}

function stop(sandbox: FakeSandbox): void {
  killAll(sandbox);
  sandbox.status = 'stopped';
}

export class SandboxHandle {
  constructor(private readonly state: FakeSandbox) {}

  get name(): string {
    return this.state.name;
  }

  get status(): string {
    return this.state.status;
  }

  config(): Record<string, unknown> {
    return networkConfig(this.state, true);
  }

  connectOrStart({ detached = false }: { detached?: boolean } = {}): Promise<Sandbox> {
    failIfAsked('connect');
    if (this.state.status !== 'running') {
      this.state.status = 'running';
      this.state.generation += 1;
      this.state.starts += 1;
    }
    this.state.detached ||= detached;
    return Promise.resolve(new Sandbox(this.state));
  }

  stop(): Promise<void> {
    stop(this.state);
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    if (!sandboxes.has(this.state.name)) {
      return Promise.reject(new SandboxNotFoundError(this.state.name));
    }
    stop(this.state);
    sandboxes.delete(this.state.name);
    return Promise.resolve();
  }
}

interface FakeNetworkBuilder {
  policy(policy: Policy): FakeNetworkBuilder;
  tls(configure: (tls: object) => object): FakeNetworkBuilder;
}

class MountBuilder {
  host?: string;
  bind(host: string): this {
    this.host = host;
    return this;
  }
}

/** What the sandbox and restore builders share. */
abstract class Settings {
  settings: Partial<FakeSandbox> = { ports: [], mounts: {} };

  cpus(cpus: number): this {
    this.settings.cpus = cpus;
    return this;
  }
  memory(memory: number): this {
    this.settings.memory = memory;
    return this;
  }
  user(user: string): this {
    this.settings.user = user;
    return this;
  }
  port(hostPort: number, guestPort: number): this {
    this.settings.ports?.push({ hostPort, guestPort });
    return this;
  }
  volume(guest: string, configure: (mount: MountBuilder) => MountBuilder): this {
    const { host } = configure(new MountBuilder());
    if (host !== undefined && this.settings.mounts) this.settings.mounts[guest] = host;
    return this;
  }

  /** Adds the sandbox `name`, its mounts linked into its root. */
  protected add(name: string, from?: string): FakeSandbox {
    if (sandboxes.has(name)) throw new SandboxAlreadyExistsError(name);
    const sandbox = newSandbox(name, this.settings);
    if (from !== undefined) cpSync(from, sandbox.root, { recursive: true });
    for (const [guest, host] of Object.entries(sandbox.mounts)) {
      rmSync(hostPath(sandbox, guest), { recursive: true, force: true });
      symlinkSync(host, hostPath(sandbox, guest));
    }
    sandboxes.set(name, sandbox);
    return sandbox;
  }
}

export class SandboxBuilder extends Settings {
  constructor(private readonly name: string) {
    super();
  }
  image(image: string): this {
    this.settings.image = image;
    return this;
  }
  detached(detached: boolean): this {
    this.settings.detached = detached;
    return this;
  }
  network(configure: (network: FakeNetworkBuilder) => unknown): this {
    const settings = this.settings;
    const network: FakeNetworkBuilder = {
      policy: (policy) => {
        settings.networkPolicy = policy;
        return network;
      },
      tls: (tls) => {
        tls({});
        settings.interceptTls = true;
        return network;
      },
    };
    configure(network);
    return this;
  }
  create(): Promise<Sandbox> {
    return new Promise((resolve) => {
      failIfAsked('create');
      resolve(new Sandbox(this.add(this.name)));
    });
  }
}

export class RestoreBuilder extends Settings {
  private sandboxName = '';

  constructor(private readonly snapshot: string) {
    super();
  }
  name(name: string): this {
    this.sandboxName = name;
    return this;
  }
  networkPolicy(policy: Policy): this {
    this.settings.networkPolicy = policy;
    return this;
  }
  restore(): Promise<Sandbox> {
    return new Promise((resolve) => {
      failIfAsked('restore');
      const snapshot = [...snapshots.values()].find(({ reference }) => reference === this.snapshot);
      if (snapshot === undefined) throw new MicrosandboxError('custom', 'snapshot not found');
      this.settings.snapshot = snapshot.name;
      this.settings.detached = true;
      resolve(new Sandbox(this.add(this.sandboxName, snapshot.from)));
    });
  }
}

class SnapshotBuilder {
  private source = '';
  private groupName = '';

  constructor(private readonly name: string) {}

  fromSandbox(source: string): this {
    this.source = source;
    return this;
  }
  group(group: string): this {
    this.groupName = group;
    return this;
  }
  create(): Promise<void> {
    return new Promise((resolve) => {
      failIfAsked('snapshot');
      const sandbox = fake.sandbox(this.source);
      if (sandbox.status !== 'stopped') throw new CustomError('snapshot of a running sandbox');
      const from = mkdtempSync(join(tmpdir(), 'fake-microsandbox-snapshot-'));
      temporary.push(from);
      cpSync(sandbox.root, from, { recursive: true });
      snapshots.set(this.name, {
        name: this.name,
        group: this.groupName,
        reference: `${from}#${this.name}`,
        from,
      });
      resolve();
    });
  }
}

export const Snapshot = {
  builder: (name: string): SnapshotBuilder => new SnapshotBuilder(name),
  list: (): Promise<{ name: string; reference: string }[]> =>
    Promise.resolve([...snapshots.values()].map(({ name, reference }) => ({ name, reference }))),
};
