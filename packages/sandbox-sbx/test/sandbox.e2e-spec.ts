import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import type { SbxNetworkSandboxSession } from '../src/index.js';

import { createSbxNetworkSandboxSession, resumeSbxNetworkSandboxSession } from '../src/index.js';
import { templateReference } from '../src/lifecycle/sandbox-template.js';

/**
 * Against the real `sbx` CLI: needs Docker Sandboxes installed and signed in. Every sandbox and
 * image it makes is removed at the end.
 */
const binary = process.env.SBX_BIN ?? 'sbx';
const run = randomBytes(3).toString('hex');
const sessions: SbxNetworkSandboxSession[] = [];
const template: HarnessV1SandboxTemplate = {
  identity: `e2e-${run}`,
  prepare: async ({ session }) => {
    const { exitCode } = await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    expect(exitCode).toBe(0);
  },
};

afterAll(async () => {
  await Promise.all(sessions.map((session) => session.destroy()));
  spawnSync(binary, [
    'template',
    'rm',
    '--force',
    templateReference({ template, agent: 'shell', setup: [] }),
  ]);
});

describe('a Docker Sandbox', () => {
  let session: SbxNetworkSandboxSession;

  it('is created, with the proxy-managed credentials out of the way', async () => {
    session = await createSbxNetworkSandboxSession({
      binary,
      sandboxId: `ai-sdk-sbx-e2e-${run}`,
      ports: [4000],
    });
    sessions.push(session);

    const { stdout } = await session.run({ command: 'echo "[$ANTHROPIC_API_KEY]"; whoami' });

    expect(stdout).toBe('[]\nagent\n');
    expect(session.defaultWorkingDirectory).toMatch(/^\//);
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
  });

  it('forwards a variable without putting it on a command line', async () => {
    const { stdout } = await session.run({ command: 'echo "$SECRET"', env: { SECRET: 's3cr3t' } });

    expect(stdout.trim()).toBe('s3cr3t');
  });

  it('serves an exposed port on the host loopback', async () => {
    const server = await session.spawn({
      command:
        "node -e \"require('http').createServer((q, r) => r.end('from the sandbox')).listen(4000)\"",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const { url } = await session.getPortEndpoint({ port: 4000 });
    const response = await fetch(url);

    expect(await response.text()).toBe('from the sandbox');
    await server.kill();
  });

  it('is found again by its id', async () => {
    const resumed = await resumeSbxNetworkSandboxSession({ binary, sandboxId: session.id });

    expect(await resumed.readTextFile({ path: 'notes/hello.txt', endLine: 1 })).toBe('hello');
  });

  it('starts from a template baked once', async () => {
    const fromTemplate = await createSbxNetworkSandboxSession({
      binary,
      sandboxId: `ai-sdk-sbx-e2e-${run}-tpl`,
      template,
    });
    sessions.push(fromTemplate);

    const { stdout } = await fromTemplate.run({ command: 'cat "$HOME/baked.txt"' });

    expect(stdout.trim()).toBe('baked');
  });
});

describe('the network of a Docker Sandbox', () => {
  let fenced: SbxNetworkSandboxSession;
  /** The HTTP status `url` answers the sandbox with: `403` when the proxy refuses it. */
  const status = async (url: string): Promise<string> =>
    (await fenced.run({ command: `curl -s -m 8 -o /dev/null -w '%{http_code}' ${url}` })).stdout;

  it('reaches the listed hosts only with a custom policy', async () => {
    fenced = await createSbxNetworkSandboxSession({
      binary,
      sandboxId: `ai-sdk-sbx-e2e-${run}-net`,
      networkPolicy: { mode: 'custom', allowedHosts: ['example.com'] },
    });
    sessions.push(fenced);

    expect(await status('https://example.com')).toBe('200');
    // Allowed by the machine's policy, not by the sandbox's.
    expect(await status('https://registry.npmjs.org')).toBe('403');
    expect(await status('https://github.com')).toBe('403');
  });

  it('tells which hosts the proxy refused to it', async () => {
    const since = new Date(Date.now() - 1000);
    await status('https://github.com');

    const blocked = (await fenced.blockedRequests?.({ since })) ?? [];

    const github = blocked.find(({ host }) => host === 'github.com');
    expect(github?.port).toBe(443);
    expect(github?.reason).toMatch(/rule/);
    expect(github?.lastSeen.getTime()).toBeGreaterThanOrEqual(since.getTime());
    // Allowed by the sandbox's policy.
    expect(blocked.map(({ host }) => host)).not.toContain('example.com');
  });

  it('never reaches the metadata server, this host or a private network', async () => {
    for (const url of [
      'http://169.254.169.254/',
      'http://host.docker.internal:22',
      'http://192.168.1.1',
    ]) {
      expect(await status(url)).toBe('403');
    }
  });

  it('changes its policy while it runs', async () => {
    await fenced.setNetworkPolicy?.({ mode: 'deny-all' });
    expect(await status('https://example.com')).toBe('403');

    await fenced.setNetworkPolicy?.({ mode: 'allow-all' });
    expect(await status('https://registry.npmjs.org')).toBe('200');
    expect(await status('http://169.254.169.254/')).toBe('403');
  });

  it('runs docker compose', async () => {
    await fenced.writeTextFile({
      path: 'compose.yml',
      content: [
        'services:',
        '  redis:',
        '    image: redis:7-alpine',
        '    healthcheck:',
        '      test: ["CMD", "redis-cli", "ping"]',
        '      interval: 1s',
      ].join('\n'),
    });

    const { stdout } = await fenced.run({
      command:
        'docker compose up -d --wait >/dev/null 2>&1; docker compose exec -T redis redis-cli ping',
    });

    expect(stdout.trim()).toBe('PONG');
  });
});
