import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DockerNetworkSandboxSession } from '../src/index.js';

import {
  createDockerNetworkSandboxSession,
  DockerSandboxNotFoundError,
  resumeDockerNetworkSandboxSession,
} from '../src/index.js';

/**
 * Real sandboxes on this host's Docker Engine: needs `docker` and an image with Node.js, by default
 * `public.ecr.aws/docker/library/node:24-slim` (`DOCKER_E2E_IMAGE` to choose another). The proxy
 * reaches `example.com`. Every container and network it creates is removed.
 */
const IMAGE = process.env['DOCKER_E2E_IMAGE'] ?? 'public.ecr.aws/docker/library/node:24-slim';
const LABEL = 'ai-sdk-sandbox-docker-engine';

const dockerAvailable = (() => {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** What `docker` lists of the containers and networks a sandbox left. */
function leftovers(sandboxId: string): string {
  const filter = `label=${LABEL}=${sandboxId}`;
  const containers = execFileSync('docker', ['ps', '--all', '--quiet', '--filter', filter]);
  const networks = execFileSync('docker', ['network', 'ls', '--quiet', '--filter', filter]);
  return `${containers.toString()}${networks.toString()}`.trim();
}

/** A `CONNECT` through the sandbox's proxy, from inside it: the status the proxy answered. */
const CONNECT = `
const [host, port] = process.argv[1].split(':');
const request = require('node:http').request({ host: 'egress', port: 3128, method: 'CONNECT', path: host + ':' + port });
request.on('connect', (response, socket) => { console.log(response.statusCode); socket.destroy(); });
request.on('response', (response) => console.log(response.statusCode));
request.on('error', (error) => console.log('error ' + error.code));
request.end();
`;

describe.skipIf(!dockerAvailable)('a sandbox on Docker Engine', () => {
  let stateDirectory: string;
  let workspace: string;
  let sandbox: DockerNetworkSandboxSession;
  const sandboxId = `ai-sdk-docker-e2e-${process.pid}`;

  const connect = async (target: string): Promise<string> =>
    (
      await sandbox.run({
        command: `node -e "$CONNECT_SCRIPT" ${target}`,
        env: { CONNECT_SCRIPT: CONNECT },
      })
    ).stdout.trim();

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'docker-engine-state-'));
    workspace = await mkdtemp(join(tmpdir(), 'docker-engine-workspace-'));
    await writeFile(join(workspace, 'README.md'), '# Mounted\n');
    // The sandbox's root has no capability: it reads what anyone may read.
    await chmod(workspace, 0o755);
    sandbox = await createDockerNetworkSandboxSession({
      image: IMAGE,
      sandboxId,
      stateDirectory,
      mounts: [{ from: workspace, to: '/mnt/project', readOnly: true }],
      limits: { memory: '512m', cpus: 1, processes: 128 },
      networkPolicy: { mode: 'custom', allowedHosts: ['example.com'] },
      ports: [8080],
    });
  });

  afterAll(async () => {
    await sandbox?.destroy();
    expect(leftovers(sandboxId)).toBe('');
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it('runs commands and keeps files in its container, its mounts as they were asked', async () => {
    expect(sandbox.defaultWorkingDirectory).toBe('/workspace');
    expect((await sandbox.run({ command: 'pwd' })).stdout.trim()).toBe('/workspace');
    await sandbox.writeTextFile({ path: 'notes/a.txt', content: 'written\n' });
    expect(await sandbox.readTextFile({ path: '/workspace/notes/a.txt' })).toBe('written\n');
    expect(await sandbox.readTextFile({ path: 'missing.txt' })).toBeNull();
    expect(await sandbox.readTextFile({ path: '/mnt/project/README.md' })).toBe('# Mounted\n');
    const write = await sandbox.run({ command: 'touch /mnt/project/new.txt' });
    expect(write.exitCode).not.toBe(0);
    const env = await sandbox.run({ command: 'echo "$GREETING"', env: { GREETING: 'hello' } });
    expect(env.stdout).toBe('hello\n');
  });

  it('reaches the allowed hosts through its proxy, and nothing else', async () => {
    expect(await connect('example.com:443')).toBe('200');
    expect(await connect('example.org:443')).toBe('403');
    // No way around the proxy: the network is internal.
    const direct = await sandbox.run({
      command: `node -e "require('node:net').connect(443, '93.184.215.14').on('connect', () => { console.log('open'); process.exit(); }).on('error', (e) => { console.log(e.code); process.exit(); }); setTimeout(() => { console.log('timeout'); process.exit(); }, 3000)"`,
    });
    expect(direct.stdout.trim()).not.toBe('open');

    // Node.js's own fetch follows the proxy too.
    const fetched = await sandbox.run({
      command: `node -e "fetch('https://example.com').then((r) => console.log(r.status), (e) => console.log(e.cause?.code ?? e.message))"`,
    });
    expect(fetched.stdout.trim()).toBe('200');

    const blocked = await sandbox.blockedRequests();
    expect(blocked[0]).toMatchObject({ host: 'example.org', port: 443, reason: 'policy' });
    expect(blocked[0]?.at).toBeInstanceOf(Date);
  });

  it('applies a new network policy to the next connection', async () => {
    const since = new Date();
    await sandbox.setNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['*.example.org', 'example.org'],
    });
    expect(await connect('example.org:443')).toBe('200');
    // Whatever the policy, never a private address.
    await sandbox.setNetworkPolicy({ mode: 'allow-all' });
    expect(await connect('169.254.169.254:80')).toBe('403');
    expect(await sandbox.blockedRequests({ since })).toEqual([
      expect.objectContaining({ host: '169.254.169.254', reason: 'private-address' }),
    ]);
    await sandbox.setNetworkPolicy({ mode: 'custom', allowedHosts: ['example.com'] });
    const policy = JSON.parse(
      await readFile(join(stateDirectory, sandboxId, 'policy.json'), 'utf8'),
    ) as unknown;
    expect(policy).toEqual({ mode: 'custom', allowedHosts: ['example.com'] });
  });

  it('publishes its ports on the loopback of this host', async () => {
    const server = await sandbox.spawn({
      command: `node -e "require('node:http').createServer((q, s) => s.end('from the sandbox')).listen(8080)"`,
    });
    const { url } = await sandbox.getPortEndpoint({ port: 8080 });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    let body = '';
    for (let attempt = 0; attempt < 50 && body === ''; attempt += 1) {
      body = await fetch(url).then(
        (response) => response.text(),
        () => new Promise<string>((resolve) => setTimeout(() => resolve(''), 100)),
      );
    }
    expect(body).toBe('from the sandbox');
    expect((await sandbox.getPortEndpoint({ port: 8080, protocol: 'ws' })).url).toMatch(/^ws:/);
    await expect(sandbox.getPortEndpoint({ port: 9999 })).rejects.toThrow(/not exposed/);
    await server.kill();
  });

  it('stops, then resumes with its files', async () => {
    await sandbox.stop();
    sandbox = await resumeDockerNetworkSandboxSession({ sandboxId, stateDirectory });
    expect(await sandbox.readTextFile({ path: 'notes/a.txt' })).toBe('written\n');
    expect(await connect('example.com:443')).toBe('200');
  });

  it('cannot resume a sandbox that is gone', async () => {
    await expect(
      resumeDockerNetworkSandboxSession({ sandboxId: 'ai-sdk-docker-e2e-none', stateDirectory }),
    ).rejects.toThrow(DockerSandboxNotFoundError);
  });
});
