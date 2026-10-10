import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { Snapshot } from 'microsandbox';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { MicrosandboxNetworkSandboxSession } from '../src/index.js';

import {
  createMicrosandboxNetworkSandboxSession,
  MicrosandboxSandboxNotFoundError,
  resumeMicrosandboxNetworkSandboxSession,
} from '../src/index.js';
import { DEFAULT_IMAGE, DEFAULT_USER } from '../src/lifecycle/sandbox-spec.js';
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
  const name = templateName({ template, image: image ?? DEFAULT_IMAGE, user, setup: [] });
  const snapshot = (await Snapshot.list()).find((listed) => listed.name === name);
  if (snapshot !== undefined) await Snapshot.remove(snapshot.reference, { force: true });
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
