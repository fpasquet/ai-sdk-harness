import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fake } from '../../test/fake-microsandbox.js';
import { MicrosandboxCommandError } from '../errors/microsandbox-command-error.js';
import { MicrosandboxSandboxNotFoundError } from '../errors/microsandbox-sandbox-not-found-error.js';
import { TLS_SENTINEL_SECRET } from '../transport/microsandbox-runtime.js';
import {
  DOCKER_LOG,
  DOCKER_MARKER,
  INSTALL_DOCKER,
  START_DOCKER,
} from '../transport/sandbox-scripts.js';
import {
  createMicrosandboxNetworkSandboxSession,
  resumeMicrosandboxNetworkSandboxSession,
} from './create-session.js';
import { DOCKER_HUB_HOSTS } from './sandbox-spec.js';
import { pruneMicrosandboxTemplates, templateName } from './sandbox-template.js';

afterEach(() => fake.reset());

/** A template whose preparation leaves a file behind, and counts how often it ran. */
function templateOf(identity: string): HarnessV1SandboxTemplate & { prepared: number } {
  const template = {
    identity,
    prepared: 0,
    prepare: async ({ session }: Parameters<HarnessV1SandboxTemplate['prepare']>[0]) => {
      template.prepared += 1;
      await session.writeTextFile({ path: 'baked.txt', content: 'baked' });
    },
  };
  return template;
}

describe('createMicrosandboxNetworkSandboxSession', () => {
  it('creates a detached sandbox from node:24, sized for a harness, with TLS interception', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });

    expect(session.id).toBe('box');
    expect(session.defaultWorkingDirectory).toBe('/workspace');
    expect(fake.sandbox('box')).toMatchObject({
      image: 'node:24',
      user: 'node',
      cpus: 2,
      memory: 2048,
      detached: true,
      interceptTls: true,
    });
    expect(existsSync(join(fake.sandbox('box').root, 'workspace'))).toBe(true);
    expect(fake.sandbox('box').execs[0]).toMatchObject({ user: 'root' });
    expect(fake.sandbox('box').execs[0]?.argv.slice(3)).toEqual(['/workspace', 'node']);
  });

  it("runs another image's commands as its own user", async () => {
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', image: 'alpine' });

    expect(fake.sandbox('box').user).toBeUndefined();
    expect(fake.sandbox('box').execs[0]?.argv.slice(3)).toEqual(['/workspace', '']);
  });

  it('names the sandbox when no id is given', async () => {
    const session = await createMicrosandboxNetworkSandboxSession();

    expect(session.id).toMatch(/^ai-sdk-[0-9a-f]{8}$/);
  });

  it('passes the image, the resources, the user and the network policy on', async () => {
    await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      image: 'python:3.13',
      cpus: 4,
      memory: 4096,
      user: 'agent',
      networkPolicy: { mode: 'deny-all' },
    });

    expect(fake.sandbox('box')).toMatchObject({
      image: 'python:3.13',
      cpus: 4,
      memory: 4096,
      user: 'agent',
      networkPolicy: { defaultEgress: 'deny', defaultIngress: 'allow', rules: [] },
    });
    // The working directory is handed to the user.
    expect(fake.sandbox('box').execs[0]?.argv.slice(3)).toEqual(['/workspace', 'agent']);
  });

  it('publishes each port on a free loopback port of this host', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      ports: [4000, 4001],
    });

    const [first, second] = fake.sandbox('box').ports;
    expect(session.ports).toEqual([4000, 4001]);
    expect(first?.guestPort).toBe(4000);
    expect(first?.hostPort).not.toBe(second?.hostPort);
    expect(await session.getPortEndpoint({ port: 4000 })).toEqual({
      url: `http://127.0.0.1:${first?.hostPort}`,
    });
  });

  it('mounts a host directory as the working directory', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workspace-'));
    try {
      const session = await createMicrosandboxNetworkSandboxSession({
        sandboxId: 'box',
        workspace,
      });
      await session.writeTextFile({ path: 'from-the-agent.txt', content: 'hi' });

      expect(fake.sandbox('box').mounts).toEqual({ '/workspace': workspace });
      expect(readFileSync(join(workspace, 'from-the-agent.txt'), 'utf8')).toBe('hi');
      // Nothing to create, nothing to hand over: the directory is the host's.
      expect(fake.sandbox('box').execs.map(({ argv }) => argv[2])).not.toContain(
        expect.stringContaining('chown'),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('restricts the guest and caps its connections by default', async () => {
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });

    expect(fake.sandbox('box')).toMatchObject({ security: 'restricted', maxTcpConnections: 1024 });
    expect(fake.sandbox('box').maxDuration).toBeUndefined();
    expect(fake.sandbox('box').idleTimeout).toBeUndefined();
  });

  it('passes the security profile, the lifetime and the connection cap on', async () => {
    await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      security: 'default',
      maxDuration: 3600,
      idleTimeout: 300,
      maxTcpConnections: 64,
    });

    expect(fake.sandbox('box')).toMatchObject({
      security: 'default',
      maxDuration: 3600,
      idleTimeout: 300,
      maxTcpConnections: 64,
    });
  });

  it('mounts host directories without setuid binaries nor devices, the extra ones read-only', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workspace-'));
    const docs = mkdtempSync(join(tmpdir(), 'docs-'));
    writeFileSync(join(docs, 'readme.md'), 'docs');
    try {
      const session = await createMicrosandboxNetworkSandboxSession({
        sandboxId: 'box',
        workspace,
        readOnlyWorkspaces: [docs],
      });

      expect(fake.sandbox('box').mountOptions).toEqual({
        '/workspace': ['nosuid', 'nodev'],
        [docs]: ['readonly', 'nosuid', 'nodev'],
      });
      // Mounted at its own path.
      expect(await session.readTextFile({ path: join(docs, 'readme.md') })).toBe('docs');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(docs, { recursive: true, force: true });
    }
  });

  it('refuses a read-only workspace over the filesystem or the working directory', async () => {
    for (const path of [
      'relative/dir',
      '/',
      '//',
      '/workspace',
      '/workspace///',
      '/workspace/docs',
      '/workspace/../',
    ]) {
      await expect(
        createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', readOnlyWorkspaces: [path] }),
      ).rejects.toThrow('`readOnlyWorkspaces`');
    }
    expect(fake.sandboxes.size).toBe(0);
  });

  it('refuses a lifetime or a cap that is not a positive integer', async () => {
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', idleTimeout: 0 }),
    ).rejects.toThrow('`idleTimeout` must be a positive integer, not 0.');
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', maxDuration: 1.5 }),
    ).rejects.toThrow('`maxDuration`');
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', maxTcpConnections: -1 }),
    ).rejects.toThrow('`maxTcpConnections`');
  });

  it('runs setup as root, in order, in the working directory', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      setup: ['echo one > order.txt', 'echo two >> order.txt'],
    });

    expect(await session.readTextFile({ path: 'order.txt' })).toBe('one\ntwo\n');
    expect(fake.sandbox('box').execs.slice(1, 3)).toEqual([
      expect.objectContaining({ argv: ['sh', '-c', 'echo one > order.txt'], user: 'root' }),
      expect.objectContaining({ argv: ['sh', '-c', 'echo two >> order.txt'], user: 'root' }),
    ]);
  });

  it('removes a sandbox whose setup failed, so the id can be used again', async () => {
    const failing = createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      setup: ['echo broken >&2; exit 7', 'echo never'],
    });

    await expect(failing).rejects.toBeInstanceOf(MicrosandboxCommandError);
    await expect(failing).rejects.toMatchObject({ exitCode: 7, stderr: 'broken\n' });
    expect(fake.sandboxes.has('box')).toBe(false);
  });

  it('removes a sandbox it could not open', async () => {
    fake.fail('config');

    await expect(createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' })).rejects.toThrow(
      'config failed',
    );
    expect(fake.sandboxes.has('box')).toBe(false);
  });

  it('refuses a taken id, an invalid id and invalid ports, before creating anything', async () => {
    fake.addSandbox('taken');

    await expect(createMicrosandboxNetworkSandboxSession({ sandboxId: 'taken' })).rejects.toThrow(
      /already exists.*resumeMicrosandboxNetworkSandboxSession/,
    );
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: '-bad name' }),
    ).rejects.toThrow('"-bad name" is not a valid sandbox id');
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'x'.repeat(129) }),
    ).rejects.toThrow('is not a valid sandbox id');
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', ports: [0] }),
    ).rejects.toThrow('0 is not a TCP port');
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', ports: [4000, 4000] }),
    ).rejects.toThrow('lists a port twice');
    expect([...fake.sandboxes.keys()]).toEqual(['taken']);
  });

  it('refuses to start once aborted', async () => {
    await expect(
      createMicrosandboxNetworkSandboxSession({ abortSignal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fake.sandboxes.size).toBe(0);
  });

  it('stops running setup once aborted', async () => {
    const controller = new AbortController();
    const creating = createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      setup: ['true', 'true'],
      abortSignal: controller.signal,
    });
    controller.abort(new Error('changed my mind'));

    await expect(creating).rejects.toThrow('changed my mind');
    expect(fake.sandboxes.has('box')).toBe(false);
  });
});

describe('templates', () => {
  it('prepares the template once, in a throwaway sandbox, and restores every sandbox from it', async () => {
    const template = templateOf('harness-1');

    const first = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'one',
      setup: ['echo installed > tool.txt'],
      template,
      ports: [4000],
      user: 'agent',
    });
    const second = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'two',
      setup: ['echo installed > tool.txt'],
      template,
      user: 'agent',
    });

    expect(template.prepared).toBe(1);
    const name = templateName({
      template,
      image: 'node:24',
      user: 'agent',
      setup: ['echo installed > tool.txt'],
    });
    // In no group: microsandbox would refuse to remove the latest one while others remain.
    expect(fake.snapshots.get(name)).toMatchObject({ group: '' });
    expect([...fake.sandboxes.keys()]).toEqual(['one', 'two']);
    expect(await first.readTextFile({ path: 'baked.txt' })).toBe('baked');
    expect(await first.readTextFile({ path: 'tool.txt' })).toBe('installed\n');
    expect(await second.readTextFile({ path: 'baked.txt' })).toBe('baked');
    expect(fake.sandbox('one')).toMatchObject({
      snapshot: name,
      cpus: 2,
      memory: 2048,
      user: 'agent',
      ports: [{ guestPort: 4000, hostPort: expect.any(Number) as number }],
    });
    // Restored, they ran neither the setup nor the workspace preparation again.
    expect(fake.sandbox('one').execs.map(({ user }) => user)).not.toContain('root');
  });

  it('intercepts TLS in a restored sandbox from the start, and keeps it past the credentials', async () => {
    const template = templateOf('harness-tls');
    const session = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template });

    expect(fake.sandbox('one')).toMatchObject({ interceptTls: true, restarts: 1 });
    const sentinel = fake.sandbox('one').secrets.get(TLS_SENTINEL_SECRET);
    expect(sentinel?.allowedHosts).toEqual(['tls-interception.invalid']);
    // Its placeholder is never the value, and differs from one sandbox to the next.
    expect(sentinel?.placeholder).toMatch(/^msb-tls-[0-9a-f]{16}$/);
    expect(sentinel?.value).not.toBe(sentinel?.placeholder);

    await session.setRequestTransformations?.([]);
    await session.release();

    expect([...fake.sandbox('one').secrets.keys()]).toEqual([TLS_SENTINEL_SECRET]);
  });

  it('removes a restored sandbox whose TLS interception could not be turned on', async () => {
    const template = templateOf('harness-tls-failure');
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template });
    fake.fail('modify');

    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'two', template }),
    ).rejects.toThrow('modify failed');
    expect([...fake.sandboxes.keys()]).toEqual(['one']);
  });

  it('restores a sandbox with its own security profile, lifetime and connection cap', async () => {
    const template = templateOf('harness-hardening');
    await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'one',
      template,
      security: 'default',
      idleTimeout: 60,
      maxDuration: 600,
      maxTcpConnections: 32,
    });

    expect(fake.sandbox('one')).toMatchObject({
      snapshot: expect.any(String) as string,
      security: 'default',
      idleTimeout: 60,
      maxDuration: 600,
      maxTcpConnections: 32,
    });
  });

  it('builds one snapshot when sandboxes are created at the same time', async () => {
    const template = templateOf('harness-2');

    await Promise.all([
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template }),
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'two', template }),
    ]);

    expect(template.prepared).toBe(1);
  });

  it('gets a snapshot of its own for another harness version or another base', () => {
    const template = templateOf('harness-3');
    const names = new Set([
      templateName({ template, image: 'node:22', setup: [] }),
      templateName({ template, image: 'node:24', setup: ['true'] }),
      templateName({ template, image: 'node:24', setup: [] }),
      templateName({ template, image: 'node:24', user: 'node', setup: [] }),
      templateName({ template: templateOf('harness-4'), image: 'node:24', setup: [] }),
    ]);

    expect(names.size).toBe(5);
  });

  it('removes the throwaway sandbox when the build fails, and tries again next time', async () => {
    const template = templateOf('harness-5');
    fake.fail('snapshot');

    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template }),
    ).rejects.toThrow('snapshot failed');
    expect(fake.sandboxes.size).toBe(0);

    fake.reset();
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template });
    expect(template.prepared).toBe(2);
  });

  it('says when microsandbox did not save the snapshot', async () => {
    const template = templateOf('harness-6');
    const list = fake.snapshots.set.bind(fake.snapshots);
    // A snapshot that never shows up in the listing.
    fake.snapshots.set = () => fake.snapshots;

    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template }),
    ).rejects.toThrow('did not save the snapshot');
    fake.snapshots.set = list;
  });
});

describe('resumeMicrosandboxNetworkSandboxSession', () => {
  it('reattaches to a sandbox with the ports it was created with, starting it if stopped', async () => {
    const created = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      ports: [4000],
    });
    await created.writeTextFile({ path: 'notes.txt', content: 'kept' });
    await created.stop();

    const resumed = await resumeMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });

    expect(fake.sandbox('box').status).toBe('running');
    expect(resumed.ports).toEqual([4000]);
    expect(await resumed.readTextFile({ path: 'notes.txt' })).toBe('kept');
  });

  it('throws MicrosandboxSandboxNotFoundError for an unknown id', async () => {
    const resuming = resumeMicrosandboxNetworkSandboxSession({ sandboxId: 'missing' });

    await expect(resuming).rejects.toBeInstanceOf(MicrosandboxSandboxNotFoundError);
    await expect(resuming).rejects.toMatchObject({ sandboxId: 'missing' });
  });

  it('refuses to start once aborted', async () => {
    await expect(
      resumeMicrosandboxNetworkSandboxSession({
        sandboxId: 'box',
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });
});

describe('MicrosandboxNetworkSandboxSession', () => {
  const apiKey = {
    match: {
      host: 'api.anthropic.com',
      headers: [{ key: { exact: 'x-api-key' }, value: { exact: 'aisdkhc_1' } }],
    },
    transform: { headers: { 'x-api-key': 'sk-ant-real' } },
  };

  it('resolves a port as WebSocket, and plain HTTP for https', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ ports: [4000] });
    const hostPort = fake.sandbox(session.id).ports[0]?.hostPort;

    expect(await session.getPortEndpoint({ port: 4000, protocol: 'ws' })).toEqual({
      url: `ws://127.0.0.1:${hostPort}`,
    });
    expect(await session.getPortUrl({ port: 4000, protocol: 'https' })).toBe(
      `http://127.0.0.1:${hostPort}`,
    );
  });

  it('refuses a port it does not expose', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ ports: [4000] });

    await expect(session.getPortEndpoint({ port: 5000 })).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
  });

  it('narrows its ports, and refuses one it was not created with', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ ports: [4000, 4001] });

    await session.setPorts([4001]);

    expect(session.ports).toEqual([4001]);
    await expect(session.getPortEndpoint({ port: 4000 })).rejects.toThrow('is not exposed');
    await expect(session.setPorts([4001, 5000])).rejects.toThrow(
      'microsandbox publishes ports at creation only',
    );
    await session.setPorts([4000, 4001]);
    expect(session.ports).toEqual([4000, 4001]);
  });

  it('brokers credentials by default, and replaces them with setRequestTransformations', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });

    await session.addRequestTransformations?.([apiKey]);
    await session.setRequestTransformations?.([
      { ...apiKey, transform: { headers: { 'x-api-key': 'sk-ant-other' } } },
    ]);

    expect([...fake.sandbox('box').secrets.values()]).toEqual([
      { placeholder: 'aisdkhc_1', value: 'sk-ant-other', allowedHosts: ['api.anthropic.com'] },
    ]);
    // Same placeholder: the value was rotated live, the microVM restarted for the first one only.
    expect(fake.sandbox('box').restarts).toBe(1);
  });

  it('offers no brokering when it is turned off', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ brokerCredentials: false });

    expect(session.addRequestTransformations).toBeUndefined();
    expect(session.setRequestTransformations).toBeUndefined();
  });

  it('releases the sandbox: its processes stopped, its secrets withdrawn, the sandbox running', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });
    await session.addRequestTransformations?.([apiKey]);
    const tool = await session.restricted().spawn({ command: 'sleep 30' });

    await session.release();

    expect(await tool.wait()).toEqual({ exitCode: 137 });
    expect(fake.sandbox('box').secrets.size).toBe(0);
    expect(fake.sandbox('box').status).toBe('running');
  });

  it('stops every process started through it', async () => {
    const session = await createMicrosandboxNetworkSandboxSession();
    const running = await session.spawn({ command: 'sleep 30' });

    await session.killAllProcesses();

    expect(await running.wait()).toEqual({ exitCode: 137 });
  });

  it('stops the sandbox, keeping its files, and destroys it', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });
    writeFileSync(join(fake.sandbox('box').root, 'workspace', 'kept.txt'), 'kept');

    await session.stop();
    expect(fake.sandbox('box').status).toBe('stopped');
    expect(await session.readTextFile({ path: 'kept.txt' })).toBe('kept');

    await session.destroy();
    await session.destroy();
    expect(fake.sandboxes.has('box')).toBe(false);
  });

  it('hands tools a restricted view of the same sandbox', async () => {
    const session = await createMicrosandboxNetworkSandboxSession();
    const restricted = session.restricted();

    await restricted.writeTextFile({ path: 'shared.txt', content: 'same sandbox' });

    expect(await session.readTextFile({ path: 'shared.txt' })).toBe('same sandbox');
    expect(restricted).not.toHaveProperty('destroy');
    expect(restricted).not.toHaveProperty('addRequestTransformations');
  });
});

describe('docker', () => {
  const dockerDisk = { '/var/lib/docker': ['owned:disk:10240'] };

  it('installs Docker as root before the setup, on a disk of its own, and starts its daemon', async () => {
    const session = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      docker: true,
      setup: ['echo after'],
    });

    expect(fake.sandbox('box')).toMatchObject({ security: 'default', memory: 4096 });
    expect(fake.sandbox('box').mountOptions).toEqual(dockerDisk);
    const scripts = fake.sandbox('box').execs.map(({ argv, user }) => [argv[2], user]);
    const install = scripts.findIndex(([script]) => script === INSTALL_DOCKER);
    expect(scripts[install]?.[1]).toBe('root');
    expect(install).toBeLessThan(scripts.findIndex(([script]) => script === 'echo after'));
    // The socket goes to the user's group, recorded in the sandbox.
    expect(await session.readTextFile({ path: DOCKER_MARKER })).toBe('node\n');
    expect(fake.sandbox('box').jobs).toEqual([['-c', START_DOCKER, DOCKER_MARKER, DOCKER_LOG]]);
    expect(session.description).toContain('Docker runs in the sandbox');
  });

  it('starts the daemon again on every start of the sandbox', async () => {
    const created = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      docker: true,
    });
    await created.stop();

    const resumed = await resumeMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });

    expect(fake.sandbox('box').jobs).toHaveLength(2);
    expect(resumed.description).toContain('Docker runs in the sandbox');
  });

  it('starts nothing in a sandbox without Docker, nor tells the agent about it', async () => {
    const created = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });
    await created.stop();

    const resumed = await resumeMicrosandboxNetworkSandboxSession({ sandboxId: 'box' });

    expect(fake.sandbox('box').jobs).toEqual([]);
    expect(resumed.description).not.toContain('Docker');
  });

  it('sizes its disk, and keeps the memory and the profile it is given', async () => {
    await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'box',
      docker: { diskSize: 2048 },
      memory: 8192,
      security: 'default',
    });

    expect(fake.sandbox('box')).toMatchObject({ memory: 8192, security: 'default' });
    expect(fake.sandbox('box').mountOptions).toEqual({ '/var/lib/docker': ['owned:disk:2048'] });
  });

  it('refuses the restricted profile, which a Docker daemon cannot run under', async () => {
    await expect(
      createMicrosandboxNetworkSandboxSession({
        sandboxId: 'box',
        docker: true,
        security: 'restricted',
      }),
    ).rejects.toThrow('`docker` needs root semantics');
    await expect(
      createMicrosandboxNetworkSandboxSession({ sandboxId: 'box', docker: { diskSize: 0 } }),
    ).rejects.toThrow('`docker.diskSize`');
    expect(fake.sandboxes.size).toBe(0);
  });

  it('lets a custom policy reach Docker Hub, and leaves the others as they are', async () => {
    await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'custom',
      docker: true,
      networkPolicy: { mode: 'custom', allowedHosts: ['api.anthropic.com'] },
    });
    await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'denied',
      docker: true,
      networkPolicy: { mode: 'deny-all' },
    });

    const rules = fake.sandbox('custom').networkPolicy?.rules as { destination: unknown }[];
    const destinations = rules.map(({ destination }) => destination);
    expect(destinations).toEqual(
      ['api.anthropic.com', ...DOCKER_HUB_HOSTS].map((domain) => ({ kind: 'domain', domain })),
    );
    expect(fake.sandbox('denied').networkPolicy?.rules).toEqual([]);
  });

  it('bakes Docker into a template of its own, and starts it in every restored sandbox', async () => {
    const template = templateOf('harness-docker');
    const base = { template, image: 'node:24', user: 'node', setup: [] };
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'plain', template });
    const session = await createMicrosandboxNetworkSandboxSession({
      sandboxId: 'one',
      template,
      docker: true,
    });

    expect(templateName({ ...base, docker: { diskSize: 10_240 } })).not.toBe(templateName(base));
    expect(templateName({ ...base, docker: { diskSize: 10_240 } })).not.toBe(
      templateName({ ...base, docker: { diskSize: 20_480 } }),
    );
    expect(fake.snapshots.size).toBe(2);
    expect(fake.sandbox('one').mountOptions).toEqual(dockerDisk);
    expect(fake.sandbox('one').jobs).toHaveLength(1);
    expect(fake.sandbox('plain').jobs).toEqual([]);
    expect(session.description).toContain('Docker runs in the sandbox');
  });
});

describe('pruneMicrosandboxTemplates', () => {
  it('removes the templates, keeps the sandboxes restored from them, and builds them again', async () => {
    const template = templateOf('harness-prune');
    const restored = await createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template });
    fake.snapshots.set('unrelated', { ...[...fake.snapshots.values()][0]!, name: 'unrelated' });

    const removed = await pruneMicrosandboxTemplates();

    expect(removed).toEqual([
      templateName({ template, image: 'node:24', user: 'node', setup: [] }),
    ]);
    expect([...fake.snapshots.keys()]).toEqual(['unrelated']);
    expect(await restored.readTextFile({ path: 'baked.txt' })).toBe('baked');
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'two', template });
    expect(template.prepared).toBe(2);
  });

  it('keeps the templates made less than olderThan ago', async () => {
    const template = templateOf('harness-prune-recent');
    await createMicrosandboxNetworkSandboxSession({ sandboxId: 'one', template });

    expect(await pruneMicrosandboxTemplates({ olderThan: 60_000 })).toEqual([]);
    expect(fake.snapshots.size).toBe(1);
  });
});
