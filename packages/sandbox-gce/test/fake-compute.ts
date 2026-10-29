import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { TEST_BUILD } from './build-helpers.js';

/** A machine of the fake, its disk a directory, its agent a process of this host. */
interface FakeInstance {
  name: string;
  status: string;
  labels: Record<string, string>;
  /** The disk's directory: the machine's home, working directory and agent state. */
  disk: string;
  /** Its metadata, the agent's token in it: read by the agent as the machine boots. */
  metadata: Metadata;
  /** The port its agent listens on, while it runs. */
  port?: number;
  agent?: ChildProcess;
  /** What the service asked for when it created it. */
  body: Record<string, unknown>;
}

type Json = Record<string, unknown>;
type Metadata = { fingerprint: string; items: { key: string; value: string }[] };
type Answer = [number, unknown];

const NOT_FOUND: Answer = [404, { error: { message: 'not found' } }];

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

/** The agent token the service put in an instance's metadata. */
const tokenOf = ({ items }: Metadata): string =>
  items.find(({ key }) => key === 'ai-sdk-sandbox-agent-token')?.value ?? '';

/** The image an instance boots from, by the last segment of its `sourceImage`. */
function sourceImageOf(body: Json): string {
  const [disk] = (body['disks'] ?? []) as { initializeParams?: { sourceImage?: string } }[];
  return disk?.initializeParams?.sourceImage?.split('/').at(-1) ?? '';
}

/**
 * A fake Compute Engine API on the loopback, its state in `root`. An instance's boot starts the
 * package's agent, built, as a process of this host, on a port of its own; stopping it stops the
 * agent, the disk kept. An image is a copy of a disk. Nothing is isolated: the commands run on this
 * host. Every operation is done as soon as it is answered.
 */
export class FakeCompute {
  readonly project = 'test-project';
  readonly zone = 'test-zone';
  /** The base image of the sandboxes, as the service is configured with it. */
  readonly image = `projects/${this.project}/global/images/family/sandbox`;
  /** Another image the service offers: its disk marks it, `/etc/image` holding `python`. */
  readonly pythonImage = `projects/${this.project}/global/images/family/python`;
  /** Every call, `METHOD path`, in order. */
  readonly calls: string[] = [];
  /** Images, by name: their disk's directory. */
  readonly images = new Map<string, string>();
  /** The API's root, once it listens. */
  endpoint = '';

  private readonly instances = new Map<string, FakeInstance>();
  private readonly server: Server;
  private operations = 0;

  private readonly routes: [string, RegExp, (name: string, body: Json) => Promise<Answer>][] = [
    ['GET', /\/zones\/[^/]+\/instances\/([^/]+)$/, (name) => Promise.resolve(this.get(name))],
    // Every instance: they all carry the service's label.
    ['GET', /\/zones\/[^/]+\/instances$/, () => Promise.resolve(this.list())],
    ['POST', /\/zones\/[^/]+\/instances$/, (_, body) => this.insert(body)],
    ['POST', /\/zones\/[^/]+\/instances\/([^/]+)\/stop$/, (name) => this.stop(name)],
    ['POST', /\/zones\/[^/]+\/instances\/([^/]+)\/start$/, (name) => this.start(name)],
    [
      'POST',
      /\/zones\/[^/]+\/instances\/([^/]+)\/setMetadata$/,
      (name, body) => Promise.resolve(this.setMetadata(name, body)),
    ],
    ['DELETE', /\/zones\/[^/]+\/instances\/([^/]+)$/, (name) => this.remove(name)],
    [
      'GET',
      /\/global\/images\/family\/([^/]+)$/,
      (family) => Promise.resolve([200, this.imageOf(`${family}-v1`)]),
    ],
    ['GET', /\/global\/images\/([^/]+)$/, (name) => Promise.resolve(this.getImage(name))],
    ['POST', /\/global\/images$/, (_, body) => Promise.resolve(this.insertImage(body))],
    ['DELETE', /\/global\/images\/([^/]+)$/, (name) => Promise.resolve(this.deleteImage(name))],
  ];

  constructor(private readonly root: string) {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  instance(name: string): FakeInstance | undefined {
    return this.instances.get(name);
  }

  /** The port of the agent of the running instance `name`. */
  agentPort(name: string): number {
    return this.instances.get(name)?.port ?? 0;
  }

  /** Where the disk of the instance `name` lives: `home/` and `workspace/` in it. */
  diskOf(name: string): string {
    return join(this.root, 'disks', name);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.instances.values()].map((instance) => this.halt(instance)));
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://compute').pathname;
    this.calls.push(`${request.method} ${path}`);
    const route = this.routes.find(
      ([method, pattern]) => method === request.method && pattern.test(path),
    );
    const [status, body] =
      route === undefined
        ? [404, { error: { message: `no fake for ${path}` } }]
        : await route[2](route[1].exec(path)?.[1] ?? '', await readBody(request));
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private operation(): Answer {
    const name = `operation-${++this.operations}`;
    return [200, { name, status: 'DONE', selfLink: `${this.endpoint}/operations/${name}` }];
  }

  private list(): Answer {
    return [200, { items: [...this.instances.keys()].map((name) => this.get(name)[1]) }];
  }

  private get(name: string): Answer {
    const instance = this.instances.get(name);
    if (instance === undefined) return NOT_FOUND;
    return [
      200,
      {
        name: instance.name,
        status: instance.status,
        labels: instance.labels,
        networkInterfaces: [{ networkIP: '127.0.0.1' }],
        metadata: instance.metadata,
      },
    ];
  }

  private async insert(body: Json): Promise<Answer> {
    const name = String(body['name']);
    if (this.instances.has(name)) return [409, { error: { message: `${name} already exists` } }];
    const disk = this.diskOf(name);
    const image = this.images.get(sourceImageOf(body));
    rmSync(disk, { recursive: true, force: true });
    if (image === undefined) {
      mkdirSync(disk, { recursive: true });
      // A disk made from an image of the service says which, beside the home: `image.txt`.
      writeFileSync(join(disk, 'image.txt'), sourceImageOf(body));
    } else cpSync(image, disk, { recursive: true });
    const instance: FakeInstance = {
      name,
      status: 'STAGING',
      labels: (body['labels'] ?? {}) as Record<string, string>,
      disk,
      metadata: { fingerprint: 'f0', items: [], ...(body['metadata'] as Partial<Metadata>) },
      body,
    };
    this.instances.set(name, instance);
    await this.boot(instance);
    return this.operation();
  }

  private async stop(name: string): Promise<Answer> {
    const instance = this.instances.get(name);
    if (instance === undefined) return NOT_FOUND;
    await this.halt(instance);
    return this.operation();
  }

  private async start(name: string): Promise<Answer> {
    const instance = this.instances.get(name);
    if (instance === undefined) return NOT_FOUND;
    if (instance.status !== 'RUNNING') await this.boot(instance);
    return this.operation();
  }

  /** Replaces the metadata of `name`, unless it changed since its `fingerprint` was read. */
  private setMetadata(name: string, body: Json): Answer {
    const instance = this.instances.get(name);
    if (instance === undefined) return NOT_FOUND;
    if (body['fingerprint'] !== instance.metadata.fingerprint) {
      return [412, { error: { message: 'Supplied fingerprint does not match current metadata' } }];
    }
    const items = (body['items'] ?? []) as Metadata['items'];
    instance.metadata = { fingerprint: `f${++this.operations}`, items };
    return this.operation();
  }

  private async remove(name: string): Promise<Answer> {
    const instance = this.instances.get(name);
    if (instance === undefined) return NOT_FOUND;
    await this.halt(instance);
    this.instances.delete(name);
    rmSync(instance.disk, { recursive: true, force: true });
    return this.operation();
  }

  private imageOf(name: string): Json {
    return {
      name,
      status: 'READY',
      selfLink: `${this.endpoint}/projects/${this.project}/global/images/${name}`,
    };
  }

  private getImage(name: string): Answer {
    return this.images.has(name) ? [200, this.imageOf(name)] : NOT_FOUND;
  }

  private insertImage(body: Json): Answer {
    const name = String(body['name']);
    if (this.images.has(name)) return [409, { error: { message: `${name} already exists` } }];
    const instance = this.instances.get(String(body['sourceDisk']).split('/').at(-1) ?? '');
    if (instance?.status !== 'TERMINATED')
      return [400, { error: { message: 'the disk is in use' } }];
    const copy = join(this.root, 'images', name);
    cpSync(instance.disk, copy, { recursive: true });
    this.images.set(name, copy);
    return this.operation();
  }

  private deleteImage(name: string): Answer {
    const copy = this.images.get(name);
    if (copy === undefined) return NOT_FOUND;
    this.images.delete(name);
    rmSync(copy, { recursive: true, force: true });
    return this.operation();
  }

  /** Boots the machine: its agent, as a process of this host, as the user running the tests. */
  private async boot(instance: FakeInstance): Promise<void> {
    const port = await freePort();
    const { disk } = instance;
    const path = process.env['PATH'] ?? '/usr/bin:/bin';
    instance.agent = spawn(process.execPath, [join(TEST_BUILD, 'cli.js'), 'agent'], {
      env: {
        PATH: path,
        HOST: '127.0.0.1',
        LOG_FORMAT: 'text',
        SANDBOX_AGENT_PORT: String(port),
        SANDBOX_AGENT_TOKEN: tokenOf(instance.metadata),
        SANDBOX_USER: userInfo().username,
        SANDBOX_HOME: join(disk, 'home'),
        SANDBOX_WORKDIR: join(disk, 'workspace'),
        SANDBOX_STATE_DIR: join(disk, 'state'),
        SANDBOX_PATH: path,
        SANDBOX_CONFIGURE_DOCKER: 'false',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    instance.port = port;
    instance.status = 'RUNNING';
  }

  /** Stops the machine: its agent, and the processes it started with it. */
  private async halt(instance: FakeInstance): Promise<void> {
    const { agent } = instance;
    instance.agent = undefined;
    instance.port = undefined;
    instance.status = 'TERMINATED';
    if (agent?.exitCode === null) {
      const exited = new Promise((resolve) => agent.once('exit', resolve));
      agent.kill('SIGTERM');
      await exited;
    }
  }
}

/** Starts a fake Compute Engine API, its state in `root`. */
export async function startFakeCompute(root: string): Promise<FakeCompute> {
  const compute = new FakeCompute(root);
  await compute.listen();
  return compute;
}
