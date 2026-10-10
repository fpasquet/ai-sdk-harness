import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { SrtNetworkSandboxSession } from '../src/index.js';

import {
  createSrtNetworkSandboxSession,
  resumeSrtNetworkSandboxSession,
  SrtSandboxNotFoundError,
} from '../src/index.js';
import { RUNTIME } from './srt.js';

/**
 * Real sandboxes on this host, behind srt: needs `bwrap`, `socat` and `rg` on Linux (see
 * `test/srt.ts`), `rg` on macOS, and the network to reach postman-echo.com. Every sandbox it makes
 * is removed at the end, with the directory it worked in.
 */
const run = randomBytes(3).toString('hex');
const sessions: SrtNetworkSandboxSession[] = [];
/** A directory of the host user's home, which the sandboxes hide but for what they need. */
const workspace = await mkdtemp(join(homedir(), '.ai-sdk-srt-e2e-'));
const template: HarnessV1SandboxTemplate = {
  identity: `e2e-${run}`,
  prepare: async ({ session }) => {
    const { exitCode } = await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    expect(exitCode).toBe(0);
  },
};

afterAll(async () => {
  await Promise.all(sessions.map((session) => session.destroy()));
  await rm(workspace, { recursive: true, force: true });
});

describe('an srt sandbox', () => {
  let session: SrtNetworkSandboxSession;

  it('is created, with nothing of this process environment', async () => {
    process.env.AI_SDK_SRT_E2E_SECRET = 'never-seen';
    session = await createSrtNetworkSandboxSession({
      sandboxId: `ai-sdk-srt-e2e-${run}`,
      ports: [4000],
      workspace,
      allowedDomains: ['postman-echo.com'],
      runtime: RUNTIME,
    });
    sessions.push(session);

    const { stdout } = await session.run({ command: 'echo "[$AI_SDK_SRT_E2E_SECRET]"; pwd' });

    expect(stdout).toBe(`[]\n${workspace}\n`);
    expect(session.defaultWorkingDirectory).toBe(workspace);
  });

  it('reads and writes files, the workspace being the host directory', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);

    await session.writeTextFile({ path: 'notes/hello.txt', content: 'hello\nfrom\nthe host' });
    await session.writeBinaryFile({ path: 'blob.bin', content: bytes });

    expect(await session.readTextFile({ path: 'notes/hello.txt', startLine: 2 })).toBe(
      'from\nthe host',
    );
    expect(await session.readBinaryFile({ path: 'blob.bin' })).toEqual(bytes);
    expect(await session.readTextFile({ path: 'missing.txt' })).toBeNull();
    expect(await readFile(join(workspace, 'notes/hello.txt'), 'utf8')).toBe(
      'hello\nfrom\nthe host',
    );
  });

  it('forwards a variable without putting it on a command line', async () => {
    const { stdout } = await session.run({ command: 'echo "$SECRET"', env: { SECRET: 's3cr3t' } });

    expect(stdout.trim()).toBe('s3cr3t');
  });

  it("hides the host user's home, and keeps writes out of it", async () => {
    const marker = join(homedir(), `.ai-sdk-srt-e2e-${run}`);
    await writeFile(`${marker}-visible`, 'on the host');

    const { stdout } = await session.run({
      command: `cat ${marker}-visible 2>&1; ls ~/.ssh 2>&1; touch ${marker}-written; echo done`,
    });

    expect(stdout).toContain('No such file or directory');
    expect(stdout).not.toContain('on the host');
    await expect(readFile(`${marker}-written`)).rejects.toThrow();
    await rm(`${marker}-visible`);
  });

  it('serves an exposed port on the host loopback', async () => {
    const server = await session.spawn({
      command:
        "node -e \"require('http').createServer((q, r) => r.end('from the sandbox')).listen(4000, () => console.log('up'))\"",
    });
    await server.stdout.getReader().read();

    const { url } = await session.getPortEndpoint({ port: 4000 });

    expect(await (await fetch(url)).text()).toBe('from the sandbox');
    await server.kill();
  });

  it('only reaches the allowed hosts', async () => {
    const { stdout } = await session.run({
      command:
        'curl -s -o /dev/null -w "%{http_code} " https://postman-echo.com/get; curl -s -o /dev/null -w "%{http_code}" https://example.com',
    });

    expect(stdout).toBe('200 000');
  });

  it('puts a brokered credential in the requests, the sandbox holding a placeholder', async () => {
    const placeholder = `aisdkhc_${randomBytes(32).toString('base64url')}`;
    await session.addRequestTransformations?.([
      {
        match: {
          host: 'postman-echo.com',
          headers: [{ key: { exact: 'X-Api-Key' }, value: { exact: placeholder } }],
        },
        transform: { headers: { 'X-Api-Key': 'the-real-secret' } },
      },
    ]);

    const { stdout } = await session.run({
      command: 'curl -s https://postman-echo.com/headers -H "X-Api-Key: $KEY"',
      env: { KEY: placeholder },
    });

    expect(JSON.parse(stdout)).toMatchObject({ headers: { 'x-api-key': 'the-real-secret' } });
    await session.release();
  });

  it('keeps its allowed hosts its own where srt keeps a list per sandbox', async () => {
    const other = await createSrtNetworkSandboxSession({
      sandboxId: `ai-sdk-srt-e2e-${run}-other`,
      allowedDomains: ['example.com'],
      runtime: RUNTIME,
    });
    sessions.push(other);
    const reach = async (sandbox: SrtNetworkSandboxSession): Promise<string> =>
      (
        await sandbox.run({
          command: 'curl -s -o /dev/null -w "%{http_code}" https://example.com',
        })
      ).stdout;

    expect(await reach(other)).toBe('200');
    // srt 0.0.79 has one allow list for the process, the union of every sandbox's.
    expect(await reach(session)).toBe(session.isolatesNetwork ? '000' : '200');
    await other.stop();
  });

  it('follows a new network policy', async () => {
    await session.setNetworkPolicy({ mode: 'deny-all' });

    const { stdout } = await session.run({
      command: 'curl -s -o /dev/null -w "%{http_code}" https://postman-echo.com/get',
    });

    expect(stdout).toBe('000');
    await session.setNetworkPolicy({ mode: 'custom', allowedHosts: ['postman-echo.com'] });
  });

  it('is found again by its id, its processes gone', async () => {
    await session.stop();
    const resumed = await resumeSrtNetworkSandboxSession({
      sandboxId: session.id,
      runtime: RUNTIME,
    });

    expect(await resumed.readTextFile({ path: 'notes/hello.txt', endLine: 1 })).toBe('hello');
    await expect(
      resumeSrtNetworkSandboxSession({ sandboxId: `missing-${run}`, runtime: RUNTIME }),
    ).rejects.toThrow(SrtSandboxNotFoundError);
  });

  it('is prepared from a template, in a directory of its own', async () => {
    const fromTemplate = await createSrtNetworkSandboxSession({
      sandboxId: `ai-sdk-srt-e2e-${run}-tpl`,
      template,
      runtime: RUNTIME,
    });
    sessions.push(fromTemplate);

    const { stdout } = await fromTemplate.run({ command: 'cat "$HOME/baked.txt"; pwd' });

    expect(stdout).toBe(`baked\n${fromTemplate.defaultWorkingDirectory}\n`);
  });
});
