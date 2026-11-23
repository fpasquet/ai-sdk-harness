import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { TEST_BUILD } from './build-helpers.js';

type Json = Record<string, unknown>;
type Answer = [number, unknown];

/** A sandbox of the fake, its volume a directory, its pod an agent process of this host. */
interface FakeSandbox {
  name: string;
  /** What the service asked for when it created it, its operating mode patched since. */
  body: Json;
  /** The volume's directory: the sandbox's home. */
  volume: string;
  /** The port its agent listens on, while its pod runs. */
  port?: number;
  agent?: ChildProcess;
}

interface FakeSnapshot {
  body: Json;
  directory: string;
}

const NOT_FOUND: Answer = [404, { kind: 'Status', message: 'not found' }];
const SANDBOXES =
  /^\/apis\/agents\.x-k8s\.io\/v1beta1\/namespaces\/([^/]+)\/sandboxes(?:\/([^/]+))?$/;
const SNAPSHOTS =
  /^\/apis\/snapshot\.storage\.k8s\.io\/v1\/namespaces\/([^/]+)\/volumesnapshots(?:\/([^/]+))?$/;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return text === '' ? {} : (JSON.parse(text) as Json);
}

const objectAt = (value: unknown, ...path: string[]): Json =>
  path.reduce<Json>((at, key) => (at[key] ?? {}) as Json, (value ?? {}) as Json);

/** The first container of a sandbox's pod. */
function containerOf(body: Json): Json {
  const [container] = (objectAt(body, 'spec', 'podTemplate', 'spec')['containers'] ?? []) as Json[];
  return container ?? {};
}

/** The value of the variable `name` the service gave a sandbox's container. */
function variableOf(body: Json, name: string): string {
  const env = (containerOf(body)['env'] ?? []) as { name: string; value: string }[];
  return env.find((variable) => variable.name === name)?.value ?? '';
}

/**
 * A fake Kubernetes API on the loopback, with agent-sandbox's `Sandbox` and the snapshots, its state
 * in `root`. A running sandbox's pod is the package's agent, built, as a process of this host, on a
 * port of its own; suspending it stops the agent, the volume kept. A snapshot is a copy of a
 * volume. Nothing is isolated: the commands run on this host. Everything is done as soon as it is
 * answered.
 */
export class FakeKubernetes {
  readonly namespace = 'sandboxes';
  /** Every call, `METHOD path`, in order. */
  readonly calls: string[] = [];
  readonly snapshots = new Map<string, FakeSnapshot>();
  /** The API's root, once it listens. */
  endpoint = '';

  private readonly sandboxes = new Map<string, FakeSandbox>();
  private readonly server: Server;

  constructor(private readonly root: string) {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  sandbox(name: string): FakeSandbox | undefined {
    return this.sandboxes.get(name);
  }

  /** Whether the pod of the sandbox `name` runs. */
  running(name: string): boolean {
    return this.sandboxes.get(name)?.agent !== undefined;
  }

  /** The port of the agent of the running sandbox `name`. */
  agentPort(name: string): number {
    return this.sandboxes.get(name)?.port ?? 0;
  }

  /** Where the volume of the sandbox `name` lives: its home, `workspace/` in it. */
  volumeOf(name: string): string {
    return join(this.root, 'volumes', `home-${name}`);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sandboxes.values()].map((sandbox) => this.halt(sandbox)));
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://kubernetes').pathname;
    const method = request.method ?? 'GET';
    this.calls.push(`${method} ${path}`);
    const body = await readBody(request);
    const sandbox = SANDBOXES.exec(path);
    const snapshot = SNAPSHOTS.exec(path);
    let answer: Answer = [404, { kind: 'Status', message: `no fake for ${method} ${path}` }];
    if (sandbox !== null && sandbox[1] === this.namespace) {
      answer = await this.sandboxCall(method, sandbox[2], body);
    } else if (snapshot !== null && snapshot[1] === this.namespace) {
      answer = this.snapshotCall(method, snapshot[2], body);
    }
    response.writeHead(answer[0], { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer[1]));
  }

  private async sandboxCall(method: string, name: string | undefined, body: Json): Promise<Answer> {
    if (method === 'POST' && name === undefined) return this.create(body);
    const sandbox = this.sandboxes.get(name ?? '');
    if (sandbox === undefined) return NOT_FOUND;
    if (method === 'GET') return [200, this.describe(sandbox)];
    if (method === 'PATCH') return this.patch(sandbox, body);
    if (method === 'DELETE') return this.remove(sandbox);
    return [405, { kind: 'Status', message: method }];
  }

  /** Suspends or resumes the sandbox, as its operating mode says. */
  private async patch(sandbox: FakeSandbox, body: Json): Promise<Answer> {
    const mode = objectAt(body, 'spec')['operatingMode'];
    if (typeof mode === 'string') {
      objectAt(sandbox.body, 'spec')['operatingMode'] = mode;
      if (mode === 'Suspended') await this.halt(sandbox);
      else if (sandbox.agent === undefined) await this.boot(sandbox);
    }
    return [200, this.describe(sandbox)];
  }

  private async remove(sandbox: FakeSandbox): Promise<Answer> {
    await this.halt(sandbox);
    this.sandboxes.delete(sandbox.name);
    // The volume is the sandbox's: it goes with it.
    rmSync(sandbox.volume, { recursive: true, force: true });
    return [200, { kind: 'Status', status: 'Success' }];
  }

  private async create(body: Json): Promise<Answer> {
    const name = String(objectAt(body, 'metadata')['name']);
    if (this.sandboxes.has(name)) return [409, { kind: 'Status', message: `${name} exists` }];
    const volume = this.volumeOf(name);
    const [claim] = (objectAt(body, 'spec')['volumeClaimTemplates'] ?? []) as Json[];
    const source = objectAt(claim, 'spec', 'dataSource')['name'];
    const snapshot = typeof source === 'string' ? this.snapshots.get(source) : undefined;
    rmSync(volume, { recursive: true, force: true });
    if (snapshot === undefined) {
      mkdirSync(volume, { recursive: true });
      // A fresh volume says which image the pod runs: `.image` in the home.
      writeFileSync(join(volume, '.image'), String(containerOf(body)['image']));
    } else cpSync(snapshot.directory, volume, { recursive: true });
    const sandbox: FakeSandbox = { name, body, volume };
    this.sandboxes.set(name, sandbox);
    if (objectAt(body, 'spec')['operatingMode'] !== 'Suspended') await this.boot(sandbox);
    return [201, this.describe(sandbox)];
  }

  private describe(sandbox: FakeSandbox): Json {
    const running = sandbox.agent !== undefined;
    return {
      ...sandbox.body,
      status: running
        ? {
            podIPs: ['127.0.0.1'],
            conditions: [
              { type: 'Ready', status: 'True', reason: 'DependenciesReady' },
              { type: 'Suspended', status: 'False', reason: 'NotSuspended' },
            ],
          }
        : {
            conditions: [
              { type: 'Ready', status: 'False', reason: 'SandboxSuspended' },
              { type: 'Suspended', status: 'True', reason: 'PodTerminated' },
            ],
          },
    };
  }

  private snapshotCall(method: string, name: string | undefined, body: Json): Answer {
    if (method === 'POST' && name === undefined) return this.cut(body);
    const snapshot = this.snapshots.get(name ?? '');
    if (snapshot === undefined) return NOT_FOUND;
    if (method === 'GET') return [200, { ...snapshot.body, status: { readyToUse: true } }];
    if (method !== 'DELETE') return [405, { kind: 'Status', message: method }];
    this.snapshots.delete(name ?? '');
    rmSync(snapshot.directory, { recursive: true, force: true });
    return [200, { kind: 'Status', status: 'Success' }];
  }

  /** Copies the volume a snapshot names, which only a suspended sandbox may hold. */
  private cut(body: Json): Answer {
    const name = String(objectAt(body, 'metadata')['name']);
    if (this.snapshots.has(name)) return [409, { kind: 'Status', message: 'exists' }];
    const claim = String(objectAt(body, 'spec', 'source')['persistentVolumeClaimName']);
    const owner = [...this.sandboxes.values()].find((sandbox) => `home-${sandbox.name}` === claim);
    if (owner === undefined || !existsSync(owner.volume)) return NOT_FOUND;
    if (owner.agent !== undefined) {
      return [400, { kind: 'Status', message: 'the fake only snapshots volumes at rest' }];
    }
    const directory = join(this.root, 'snapshots', name);
    cpSync(owner.volume, directory, { recursive: true });
    this.snapshots.set(name, { body, directory });
    return [201, body];
  }

  /** Makes the sandbox's pod: its agent, as a process of this host, as the user running the tests. */
  private async boot(sandbox: FakeSandbox): Promise<void> {
    const port = await freePort();
    const path = process.env['PATH'] ?? '/usr/bin:/bin';
    sandbox.agent = spawn(process.execPath, [join(TEST_BUILD, 'cli.js'), 'agent'], {
      env: {
        PATH: path,
        HOST: '127.0.0.1',
        LOG_FORMAT: 'text',
        SANDBOX_AGENT_PORT: String(port),
        SANDBOX_AGENT_TOKEN: variableOf(sandbox.body, 'SANDBOX_AGENT_TOKEN'),
        SANDBOX_USER: userInfo().username,
        SANDBOX_HOME: sandbox.volume,
        SANDBOX_WORKDIR: join(sandbox.volume, 'workspace'),
        SANDBOX_STATE_DIR: join(this.root, 'state', sandbox.name),
        SANDBOX_PATH: path,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    sandbox.port = port;
  }

  /** Deletes the sandbox's pod: its agent, and the processes it started with it. */
  private async halt(sandbox: FakeSandbox): Promise<void> {
    const { agent } = sandbox;
    sandbox.agent = undefined;
    sandbox.port = undefined;
    if (agent?.exitCode === null) {
      const exited = new Promise((resolve) => agent.once('exit', resolve));
      agent.kill('SIGTERM');
      await exited;
    }
  }
}

/** Starts a fake Kubernetes API, its state in `root`. */
export async function startFakeKubernetes(root: string): Promise<FakeKubernetes> {
  const kubernetes = new FakeKubernetes(root);
  await kubernetes.listen();
  return kubernetes;
}
