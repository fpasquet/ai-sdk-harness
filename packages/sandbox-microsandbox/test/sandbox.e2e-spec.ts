import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';
import type { AddressInfo } from 'node:net';

import { Sandbox, Snapshot } from 'microsandbox';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { MicrosandboxNetworkSandboxSession } from '../src/index.js';

import {
  createMicrosandboxNetworkSandboxSession,
  MicrosandboxSandboxNotFoundError,
  resumeMicrosandboxNetworkSandboxSession,
} from '../src/index.js';
import {
  DEFAULT_DOCKER_DISK_SIZE,
  DEFAULT_IMAGE,
  DEFAULT_USER,
} from '../src/lifecycle/sandbox-spec.js';
import { templateName } from '../src/lifecycle/sandbox-template.js';

/**
 * Against the real microsandbox runtime: needs KVM (Linux) or Apple Silicon, and is skipped
 * without. The first run pulls the image. Every sandbox and snapshot it makes is removed at the end.
 */
function hostRunsMicroVms(): boolean {
  if (process.platform === 'darwin') return process.arch === 'arm64';
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const run = randomBytes(3).toString('hex');
// The package's default image unless told otherwise, and then that image's own user.
const image = process.env.MICROSANDBOX_E2E_IMAGE;
const user = image === undefined ? DEFAULT_USER : undefined;
const workspace = mkdtempSync(join(tmpdir(), 'msb-e2e-workspace-'));
const sessions: MicrosandboxNetworkSandboxSession[] = [];
const template: HarnessV1SandboxTemplate = {
  identity: `e2e-${run}`,
  prepare: async ({ session }) => {
    const { exitCode } = await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    expect(exitCode).toBe(0);
  },
};

afterAll(async () => {
  await Promise.all(sessions.map((session) => session.destroy()));
  for (const docker of [undefined, { diskSize: DEFAULT_DOCKER_DISK_SIZE }]) {
    const name = templateName({ template, image: image ?? DEFAULT_IMAGE, user, setup: [], docker });
    const snapshot = (await Snapshot.list()).find((listed) => listed.name === name);
    if (snapshot !== undefined) await Snapshot.remove(snapshot.reference, { force: true });
  }
  rmSync(workspace, { recursive: true, force: true });
});

describe.runIf(hostRunsMicroVms())('a microsandbox', () => {
  let session: MicrosandboxNetworkSandboxSession;

  it('is created, its working directory ready', async () => {
    session = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}`,
      image,
      ports: [4000],
    });
    sessions.push(session);

    const { stdout } = await session.run({
      command: 'pwd; whoami; touch written-by-the-user; cat /proc/version',
    });

    expect(stdout).toMatch(new RegExp(`^/workspace\n${user ?? 'root'}\nLinux version`));
    expect(session.defaultWorkingDirectory).toBe('/workspace');
  });

  it('reads and writes files', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);

    await session.writeTextFile({ path: 'notes/hello.txt', content: 'hello\nfrom\nthe host' });
    await session.writeBinaryFile({ path: 'blob.bin', content: bytes });

    expect(await session.readTextFile({ path: 'notes/hello.txt', startLine: 2 })).toBe(
      'from\nthe host',
    );
    expect(await session.readBinaryFile({ path: 'blob.bin' })).toEqual(bytes);
    expect(await session.readTextFile({ path: 'missing.txt' })).toBeNull();
    await expect(session.readBinaryFile({ path: 'notes' })).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('forwards a variable to one command only', async () => {
    const { stdout } = await session.run({ command: 'echo "$SECRET"', env: { SECRET: 's3cr3t' } });
    const next = await session.run({ command: 'echo "[$SECRET]"' });

    expect(stdout.trim()).toBe('s3cr3t');
    expect(next.stdout.trim()).toBe('[]');
  });

  it('kills a process and what it started', async () => {
    const spawned = await session.spawn({ command: 'sleep 300 & sleep 301; wait' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await spawned.kill();

    expect(await spawned.wait()).toEqual({ exitCode: 137 });
    const { stdout } = await session.run({ command: 'ps -eo args | grep "^sleep 30" || true' });
    expect(stdout).toBe('');
  });

  it('serves an exposed port on the host loopback', async () => {
    const server = await session.spawn({
      command:
        "node -e \"require('http').createServer((q, r) => r.end('from the sandbox')).listen(4000)\"",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const { url } = await session.getPortEndpoint({ port: 4000 });
    const response = await fetch(url);

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await response.text()).toBe('from the sandbox');
    await server.kill();
  });

  it('puts a brokered credential in the requests, never in the sandbox', async () => {
    await session.addRequestTransformations?.([
      {
        match: {
          host: 'httpbin.org',
          headers: [{ key: { exact: 'x-api-key' }, value: { exact: 'aisdkhc_e2e' } }],
        },
        transform: { headers: { 'x-api-key': 'real-e2e-value' } },
      },
    ]);

    const { stdout } = await session.run({
      command:
        "node -e \"fetch('https://httpbin.org/headers', { headers: { 'x-api-key': 'aisdkhc_e2e' } })" +
        ".then((r) => r.json()).then((j) => console.log(j.headers['X-Api-Key']))\"",
    });
    const environment = await session.run({ command: 'env; cat /proc/1/environ | tr "\\0" "\\n"' });

    expect(stdout.trim()).toBe('real-e2e-value');
    expect(environment.stdout).not.toContain('real-e2e-value');
    expect(await session.readTextFile({ path: 'notes/hello.txt', endLine: 1 })).toBe('hello');
  });

  it('replaces its credentials with setRequestTransformations, live or with a restart', async () => {
    const echo = (header: string, placeholder: string) =>
      session.run({
        command:
          `node -e "fetch('https://httpbin.org/headers', { headers: { '${header}': '${placeholder}' } })` +
          `.then((r) => r.json()).then((j) => console.log(j.headers['${header}']))"`,
      });
    const transformation = (header: string, placeholder: string, value: string) => ({
      match: {
        host: 'httpbin.org',
        headers: [{ key: { exact: header }, value: { exact: placeholder } }],
      },
      transform: { headers: { [header]: value } },
    });

    // The same placeholder: the value rotates live.
    await session.setRequestTransformations?.([
      transformation('X-Api-Key', 'aisdkhc_e2e', 'rotated-e2e-value'),
    ]);
    expect((await echo('X-Api-Key', 'aisdkhc_e2e')).stdout.trim()).toBe('rotated-e2e-value');

    // Another credential: the previous one is withdrawn.
    await session.setRequestTransformations?.([
      transformation('X-Other-Key', 'aisdkhc_other', 'other-e2e-value'),
    ]);
    expect((await echo('X-Other-Key', 'aisdkhc_other')).stdout.trim()).toBe('other-e2e-value');
    expect((await echo('X-Api-Key', 'aisdkhc_e2e')).stdout.trim()).not.toBe('rotated-e2e-value');
  });

  it('is found again by its id once stopped, its files and ports kept', async () => {
    await session.stop();

    const resumed = await resumeMicrosandboxNetworkSandboxSession({ sandboxId: session.id });

    expect(resumed.ports).toEqual([4000]);
    expect(await resumed.readTextFile({ path: 'notes/hello.txt', endLine: 1 })).toBe('hello');
  });

  it('is not found once destroyed', async () => {
    await session.destroy();

    await expect(
      resumeMicrosandboxNetworkSandboxSession({ sandboxId: session.id }),
    ).rejects.toBeInstanceOf(MicrosandboxSandboxNotFoundError);
  });

  it('works on a directory of the host', async () => {
    writeFileSync(join(workspace, 'from-the-host.txt'), 'hello');
    const mounted = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-mnt`,
      image,
      workspace,
    });
    sessions.push(mounted);

    await mounted.writeTextFile({ path: 'from-the-sandbox.txt', content: 'hi' });

    expect(await mounted.readTextFile({ path: 'from-the-host.txt' })).toBe('hello');
    expect(readFileSync(join(workspace, 'from-the-sandbox.txt'), 'utf8')).toBe('hi');
  });

  it('starts from a template baked once', async () => {
    const fromTemplate = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-tpl`,
      image,
      template,
      ports: [4000],
    });
    sessions.push(fromTemplate);

    const { stdout } = await fromTemplate.run({ command: 'cat "$HOME/baked.txt"; pwd' });

    expect(stdout).toBe('baked\n/workspace\n');
    expect(fromTemplate.ports).toEqual([4000]);
  });
});

describe.runIf(hostRunsMicroVms())('a hardened microsandbox', () => {
  const docs = mkdtempSync(join(tmpdir(), 'msb-e2e-docs-'));
  writeFileSync(join(docs, 'readme.md'), 'docs');

  afterAll(() => rmSync(docs, { recursive: true, force: true }));

  it('runs its commands without new privileges, its host mounts nosuid and read-only', async () => {
    const hardened = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-hard`,
      image,
      template,
      workspace,
      readOnlyWorkspaces: [docs],
      maxTcpConnections: 64,
    });
    sessions.push(hardened);

    const status = await hardened.run({ command: 'grep NoNewPrivs /proc/self/status' });
    const mounts = await hardened.run({ command: `grep -E ' (/workspace|${docs}) ' /proc/mounts` });
    const write = await hardened.run({ command: `touch ${docs}/from-the-sandbox` });

    expect(status.stdout).toMatch(/NoNewPrivs:\s+1/);
    expect(mounts.stdout).toMatch(/ \/workspace \S+ \S*nosuid\S*nodev/);
    expect(mounts.stdout).toMatch(new RegExp(` ${docs} \\S+ ro,\\S*nosuid\\S*nodev`));
    expect(await hardened.readTextFile({ path: join(docs, 'readme.md') })).toBe('docs');
    expect(write.exitCode).not.toBe(0);
    const config = (await Sandbox.get(hardened.id)).config() as {
      network: { maxConnections: number };
    };
    expect(config.network.maxConnections).toBe(64);
  });

  it('keeps root semantics with the default profile', async () => {
    const permissive = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-default`,
      image,
      security: 'default',
    });
    sessions.push(permissive);

    const { stdout } = await permissive.run({ command: 'grep NoNewPrivs /proc/self/status' });

    expect(stdout).toMatch(/NoNewPrivs:\s+0/);
  });

  it('stops once idle, and starts again on the next command', async () => {
    const idle = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-idle`,
      image,
      idleTimeout: 2,
    });
    sessions.push(idle);
    await idle.writeTextFile({ path: 'kept.txt', content: 'kept' });

    let status = '';
    for (let waited = 0; waited < 30 && status !== 'stopped'; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = (await Sandbox.get(idle.id)).status;
    }

    expect(status).toBe('stopped');
    expect(await idle.readTextFile({ path: 'kept.txt' })).toBe('kept');
  });
});

describe.runIf(hostRunsMicroVms())('the network policy of a microsandbox', () => {
  // A service on this host's loopback: no policy short of naming a private block may reach it.
  const hostService = createServer((_, response) => response.end('host')).listen(0, '127.0.0.1');
  const hostUrl = (): string =>
    `http://host.microsandbox.internal:${(hostService.address() as AddressInfo).port}`;

  /** The HTTP status `url` answers the sandbox with, `000` when it cannot be reached. */
  const status = async (session: MicrosandboxNetworkSandboxSession, url: string) =>
    (await session.run({ command: `curl -s -m 8 -o /dev/null -w '%{http_code}' ${url}` })).stdout;

  afterAll(() => hostService.close());

  it('allows the public internet with allow-all, never this host', async () => {
    const open = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-all`,
      image,
      networkPolicy: { mode: 'allow-all' },
    });
    sessions.push(open);

    expect(await status(open, 'https://example.org')).toBe('200');
    expect(await status(open, hostUrl())).toBe('000');
    expect(await status(open, 'http://169.254.169.254/')).toBe('000');
  });

  it('allows the listed hosts only with custom, from a template too', async () => {
    const listed = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-custom`,
      image,
      template,
      networkPolicy: { mode: 'custom', allowedHosts: ['example.com'] },
    });
    sessions.push(listed);

    // Restored from the template, and reaching a host by name over HTTPS at once.
    expect(await status(listed, 'https://example.com')).toBe('200');
    expect(await status(listed, 'https://example.org')).toBe('000');
    expect(await status(listed, hostUrl())).toBe('000');
  });
});

describe.runIf(hostRunsMicroVms())('Docker in a microsandbox', () => {
  let docker: MicrosandboxNetworkSandboxSession;
  const compose = [
    'services:',
    '  redis:',
    '    image: redis:7-alpine',
    '    healthcheck:',
    '      test: ["CMD", "redis-cli", "ping"]',
    '      interval: 1s',
  ].join('\n');
  /** What `curl` answers in a container, `000` when it cannot reach `url`. */
  const fromContainer = (flags: string, url: string): string =>
    `docker run --rm ${flags} curlimages/curl:8.11.1 -s -m 10 -o /dev/null -w '%{http_code}' ${url}`;

  it('runs docker compose for the sandbox user, its data on an overlay2-capable disk', async () => {
    docker = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-docker`,
      image,
      template,
      docker: true,
    });
    sessions.push(docker);
    await docker.writeTextFile({ path: 'compose.yml', content: compose });

    const driver = await docker.run({ command: "docker info --format '{{.Driver}}'" });
    const up = await docker.run({
      command: 'docker compose up -d --wait && docker compose exec -T redis redis-cli ping',
    });

    expect(driver.stdout.trim()).toMatch(/^overlay/);
    expect(up.stdout.trim().split('\n').at(-1)).toBe('PONG');
    expect(docker.description).toContain('Docker runs in the sandbox');
  });

  it('keeps its containers off the host, and lets them reach HTTPS with the CA bundle', async () => {
    const bundle = '/etc/ssl/certs/ca-certificates.crt';

    const host = await docker.run({
      command: fromContainer('', 'http://host.microsandbox.internal:22'),
    });
    const bare = await docker.run({ command: fromContainer('', 'https://example.com') });
    const trusted = await docker.run({
      command: fromContainer(
        `-v ${bundle}:${bundle}:ro -e CURL_CA_BUNDLE=${bundle}`,
        'https://example.com',
      ),
    });

    expect(host.stdout).toBe('000');
    expect(bare.stdout).toBe('000');
    expect(trusted.stdout).toBe('200');
  });

  it('starts the daemon again when the sandbox starts again, its containers kept', async () => {
    await docker.stop();

    const resumed = await resumeMicrosandboxNetworkSandboxSession({ sandboxId: docker.id });
    const daemon = await resumed.run({ command: "docker info --format '{{.ServerVersion}}'" });
    // Without a restart policy, a container stays stopped when its daemon starts again.
    const kept = await resumed.run({ command: "docker compose ps -a --format '{{.Service}}'" });

    expect(daemon.exitCode).toBe(0);
    expect(kept.stdout.trim()).toBe('redis');
  });

  it('pulls from Docker Hub under a custom policy that lists only the model API', async () => {
    const fenced = await createMicrosandboxNetworkSandboxSession({
      sandboxId: `ai-sdk-msb-e2e-${run}-docker-custom`,
      image,
      template,
      docker: true,
      networkPolicy: { mode: 'custom', allowedHosts: ['api.anthropic.com'] },
    });
    sessions.push(fenced);

    const pull = await fenced.run({ command: 'docker pull -q alpine:3.20' });
    const elsewhere = await fenced.run({ command: fromContainer('', 'https://example.com') });

    expect(pull.exitCode).toBe(0);
    expect(elsewhere.stdout).toBe('000');
  });
});
