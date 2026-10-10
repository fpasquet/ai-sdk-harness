import type { AddressInfo } from 'node:net';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SrtNetworkSandboxSession } from './srt-network-sandbox-session.js';

import { FakeManager, openFakeSandbox } from '../../../test/fake-srt.js';

const opened: { root: string; session: SrtNetworkSandboxSession }[] = [];

async function open(options: Parameters<typeof openFakeSandbox>[0] = {}) {
  const sandbox = await openFakeSandbox(options);
  opened.push(sandbox);
  return sandbox;
}

/** Listens on a free port of this host, as a bridge would in a sandbox. */
async function serve(body: string): Promise<{ close: () => void; port: number }> {
  const server = createServer((request, response) => response.end(`${body} ${request.url}`));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

const placeholder = `aisdkhc_${'a'.repeat(43)}`;
const transformation = (host: string, value = placeholder) => ({
  match: {
    host,
    headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${value}` } }],
  },
  transform: { headers: { Authorization: 'Bearer real' } },
});

afterEach(async () => {
  for (const { root, session } of opened.splice(0)) {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

describe('SrtNetworkSandboxSession', () => {
  it('runs commands in its working directory, with its own home and the variables given', async () => {
    const { session, root } = await open();

    const { exitCode, stdout } = await session.run({
      command: 'echo "$PWD|$HOME|$TMPDIR|$FOO"; exit 3',
      env: { FOO: 'bar' },
    });

    expect(exitCode).toBe(3);
    expect(stdout).toBe(
      `${join(root, 'sandbox', 'workspace')}|${join(root, 'sandbox', 'home')}|${join(root, 'sandbox', 'tmp')}|bar\n`,
    );
    expect(session.id).toBe('test');
    expect(session.defaultWorkingDirectory).toBe(join(root, 'sandbox', 'workspace'));
    expect(session.description).toContain('srt sandbox "test"');
  });

  it('streams the output of a process and gives its exit code', async () => {
    const { session } = await open();

    const process = await session.spawn({
      command: 'echo out; echo err >&2; mkdir sub',
      workingDirectory: '.',
    });

    expect(await new Response(process.stdout).text()).toBe('out\n');
    expect(await new Response(process.stderr).text()).toBe('err\n');
    expect(await process.wait()).toEqual({ exitCode: 0 });
    expect((await session.run({ command: 'pwd', workingDirectory: 'sub' })).stdout).toMatch(
      /sub\n$/,
    );
  });

  it('fails like a shell in a working directory that does not exist', async () => {
    const { session } = await open();

    const { exitCode, stderr } = await session.run({
      command: 'true',
      workingDirectory: 'nowhere',
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('No such file or directory');
  });

  it('kills a process, and everything it started', async () => {
    const { session } = await open();
    const process = await session.spawn({ command: 'sleep 30 & sleep 30; wait' });

    await process.kill();

    expect(await process.wait()).toEqual({ exitCode: 137 });
  });

  it('stops a process when its signal aborts, and rejects with the reason', async () => {
    const { session } = await open();
    const controller = new AbortController();
    const process = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });

    controller.abort(new Error('stop'));

    await expect(process.wait()).rejects.toThrow('stop');
    await expect(
      session.spawn({ command: 'true', abortSignal: controller.signal }),
    ).rejects.toThrow('stop');
    await expect(
      session.readTextFile({ path: 'x', abortSignal: controller.signal }),
    ).rejects.toThrow('stop');
    await expect(
      session.writeTextFile({ path: 'x', content: '', abortSignal: controller.signal }),
    ).rejects.toThrow('stop');
  });

  it('reads and writes files, creating their directories', async () => {
    const { session, root } = await open();
    const bytes = new Uint8Array([0, 1, 2, 255]);

    await session.writeTextFile({ path: 'notes/hello.txt', content: 'hello\nfrom\nthe host' });
    await session.writeBinaryFile({ path: join(root, 'blob.bin'), content: bytes });

    expect(await session.readTextFile({ path: 'notes/hello.txt', startLine: 2 })).toBe(
      'from\nthe host',
    );
    expect(await session.readTextFile({ path: 'notes/hello.txt', endLine: 1 })).toBe('hello');
    expect(await session.readBinaryFile({ path: join(root, 'blob.bin') })).toEqual(bytes);
    expect(await new Response(await session.readFile({ path: 'notes/hello.txt' })).text()).toBe(
      'hello\nfrom\nthe host',
    );
    expect(await session.readFile({ path: 'missing.txt' })).toBeNull();
    expect(await session.readTextFile({ path: 'missing.txt' })).toBeNull();
    await expect(session.readTextFile({ path: 'notes' })).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(
      session.writeTextFile({ path: 'notes/hello.txt/inside', content: '' }),
    ).rejects.toThrow();
  });

  it('forwards an exposed port to this host, with the scheme asked for', async () => {
    const bridge = await serve('from the sandbox');
    const { session } = await open({ ports: [bridge.port] });

    const { url } = await session.getPortEndpoint({ port: bridge.port });

    expect(await (await fetch(`${url}/path`)).text()).toBe('from the sandbox /path');
    expect((await session.getPortEndpoint({ port: bridge.port, protocol: 'ws' })).url).toBe(
      url.replace('http', 'ws'),
    );
    expect(await session.getPortUrl({ port: bridge.port, protocol: 'https' })).toBe(
      url.replace('http', 'https'),
    );
    expect(session.ports).toEqual([bridge.port]);
    bridge.close();
  });

  it('refuses a port it does not expose, and drops a port no longer exposed', async () => {
    const bridge = await serve('bridge');
    const { session } = await open({ ports: [bridge.port] });
    const { url } = await session.getPortEndpoint({ port: bridge.port });

    await expect(session.getPortEndpoint({ port: 1 })).rejects.toThrow(
      HarnessCapabilityUnsupportedError,
    );
    await session.setPorts([]);

    expect(session.ports).toEqual([]);
    await expect(fetch(url)).rejects.toThrow();
    bridge.close();
  });

  it('closes a forwarded connection to a port nothing listens on', async () => {
    const bridge = await serve('gone');
    bridge.close();
    const { session } = await open({ ports: [bridge.port] });

    const { url } = await session.getPortEndpoint({ port: bridge.port });

    await expect(fetch(url)).rejects.toThrow();
  });

  it('allows the hosts of its settings, then those of its network policy', async () => {
    const { session } = await open({ allowed: ['example.com'] });
    const isolating = await open({ manager: new FakeManager({ isolating: true }) });
    await isolating.session.run({ command: 'true' });
    const [commandId] = [...isolating.manager.lists.keys()];
    expect(isolating.manager.lists.get(commandId ?? '')).toEqual(['example.com']);
    expect(isolating.session.isolatesNetwork).toBe(true);

    await isolating.session.setNetworkPolicy({
      mode: 'custom',
      allowedHosts: ['github.com'],
      allowedCIDRs: ['10.0.0.1/32'],
    });
    expect(isolating.manager.lists.get(commandId ?? '')).toEqual(['github.com', '10.0.0.1']);
    await isolating.session.setNetworkPolicy({ mode: 'deny-all' });
    expect(isolating.session.allowedDomains).toEqual([]);
    await expect(session.setNetworkPolicy({ mode: 'allow-all' })).rejects.toThrow(
      HarnessCapabilityUnsupportedError,
    );
    expect(session.isolatesNetwork).toBe(false);
  });

  it('brokers credentials: srt swaps the placeholder, and the host becomes reachable', async () => {
    const manager = new FakeManager({ isolating: true });
    const { session } = await open({ manager, allowed: [] });

    await session.addRequestTransformations?.([transformation('api.anthropic.com')]);

    expect(manager.registered.at(-1)).toMatchObject({
      sentinel: `Bearer ${placeholder}`,
      value: 'Bearer real',
      hosts: ['api.anthropic.com'],
    });
    expect(session.allowedDomains).toEqual(['api.anthropic.com']);

    const other = `aisdkhc_${'b'.repeat(43)}`;
    await session.setRequestTransformations?.([transformation('api.openai.com', other)]);

    expect(manager.registered.at(-2)).toMatchObject({
      sentinel: `Bearer ${placeholder}`,
      value: '',
      hosts: [],
    });
    expect(session.allowedDomains).toEqual(['api.openai.com']);

    await session.release();

    expect(manager.registered.at(-1)).toMatchObject({
      sentinel: `Bearer ${other}`,
      value: '',
      hosts: [],
    });
    expect(session.allowedDomains).toEqual([]);
  });

  it('refuses a credential rule srt cannot express', async () => {
    const { session } = await open();

    await expect(
      session.addRequestTransformations?.([
        { match: { host: 'api.example.com' }, transform: { headers: { 'X-Key': 'real' } } },
      ]),
    ).rejects.toThrow(HarnessCapabilityUnsupportedError);
  });

  it('forwards credentials as they are when brokering is off', async () => {
    const { session } = await open({ brokerCredentials: false });

    expect(session.addRequestTransformations).toBeUndefined();
    expect(session.setRequestTransformations).toBeUndefined();
  });

  it('gives views of itself, each releasing what it holds alone', async () => {
    const { session } = await open();
    const view = session.fork({ ports: [4100] });
    const running = await session.spawn({ command: 'sleep 30' });
    const viewRunning = await view.spawn({ command: 'sleep 30' });

    await view.release();

    expect(await viewRunning.wait()).toEqual({ exitCode: 137 });
    expect(view.ports).toEqual([4100]);
    await session.killAllProcesses();
    expect(await running.wait()).toEqual({ exitCode: 137 });
  });

  it('restricts itself to files and processes', async () => {
    const { session } = await open();

    const restricted = session.restricted();

    expect('stop' in restricted).toBe(false);
    expect((await restricted.run({ command: 'echo ok' })).stdout).toBe('ok\n');
  });

  it('starts again after a stop, and removes its directory when destroyed', async () => {
    const { session, root, manager } = await open();
    await session.run({ command: 'true' });

    await session.stop();
    await session.writeTextFile({ path: 'after-stop.txt', content: 'again' });

    expect(manager.wrapped).toHaveLength(2);
    expect(await readFile(join(root, 'sandbox', 'workspace', 'after-stop.txt'), 'utf8')).toBe(
      'again',
    );
    await session.destroy();
    expect(existsSync(root)).toBe(false);
  });
});
