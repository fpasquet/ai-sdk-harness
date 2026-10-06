import type { HarnessV1RequestTransformation, HarnessV1SandboxTemplate } from '@ai-sdk/harness';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakeService } from '../test/fake-service.js';

import { startFakeService } from '../test/fake-service.js';
import {
  CloudRunSandboxNotFoundError,
  CloudRunSandboxServiceError,
  createCloudRunNetworkSandboxSession,
  resumeCloudRunNetworkSandboxSession,
} from './index.js';
import { templateId } from './sandbox-template.js';

/** What a harness asks for to keep an Anthropic token out of the sandbox. */
const anthropicTransformation = (placeholder: string): HarnessV1RequestTransformation => ({
  match: {
    host: '127.0.0.1',
    headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${placeholder}` } }],
  },
  transform: { headers: { authorization: 'Bearer real-token' } },
});

/** A free port of the loopback, which the fake sandboxes share. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Resolves once a process has written its first output: it runs. */
async function started(process: { stdout: ReadableStream<Uint8Array> }): Promise<void> {
  const reader = process.stdout.getReader();
  await reader.read();
  reader.releaseLock();
}

/** A Node.js one-liner, run in the sandbox. */
const node = (code: string): string => `node -e '${code}'`;

describe('a Cloud Run sandbox', () => {
  let fake: FakeService;
  const options = (): { auth: 'none'; url: string } => ({ url: fake.url, auth: 'none' });

  beforeEach(async () => {
    fake = await startFakeService();
  });
  afterEach(() => fake.dispose());

  it('is created with a home and a working directory of its own', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    expect(session.id).toBe('box');
    expect(session.defaultWorkingDirectory).toBe(
      join(fake.files, 'workspace').replace('{sandbox}', 'box'),
    );
    expect(fake.calls()[0]).toEqual([
      'run',
      'box',
      '--detach',
      '--write',
      '--',
      '/bin/sleep',
      'infinity',
    ]);
    const { stdout } = await session.run({ command: 'pwd; echo "$HOME"' });
    expect(stdout).toBe(
      `${session.defaultWorkingDirectory}\n${fake.files.replace('{sandbox}', 'box')}/home\n`,
    );
  });

  it('names the sandbox itself when no id is given, and refuses an invalid one', async () => {
    const session = await createCloudRunNetworkSandboxSession(options());

    expect(session.id).toMatch(/^ai-sdk-[0-9a-f]{8}$/);
    await expect(
      createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'Not_Valid' }),
    ).rejects.toThrow('Invalid sandbox id');
  });

  it('refuses to create a sandbox whose name is taken', async () => {
    await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    const error = await createCloudRunNetworkSandboxSession({
      ...options(),
      sandboxId: 'box',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudRunSandboxServiceError);
    expect(error).toMatchObject({ status: 409 });
  });

  it('runs the setup commands once, and deletes the sandbox when one fails', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      ...options(),
      sandboxId: 'box',
      setup: ['echo one > setup.txt', 'echo two >> setup.txt'],
    });
    expect(await session.readTextFile({ path: 'setup.txt' })).toBe('one\ntwo\n');

    await expect(
      createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'broken', setup: ['exit 3'] }),
    ).rejects.toThrow('Setup command `exit 3` exited with 3');
    expect(fake.calls().at(-1)).toEqual(['delete', 'broken', '--force']);
  });

  it('hands back the real exit code, output and variables of a command', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    const result = await session.run({
      command: 'echo "out $GREETING"; echo err >&2; exit 42',
      env: { GREETING: 'hello' },
    });

    expect(result).toEqual({ exitCode: 42, stdout: 'out hello\n', stderr: 'err\n' });
    await expect(session.run({ command: 'true', env: { 'NOT-VALID': 'x' } })).rejects.toThrow(
      'Not an environment variable name',
    );
  });

  it('runs a command in a working directory relative to its own', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    await session.run({ command: 'mkdir -p sub' });

    const { stdout } = await session.run({ command: 'pwd', workingDirectory: 'sub' });

    expect(stdout).toBe(`${session.defaultWorkingDirectory}/sub\n`);
  });

  it('keeps nothing of the service environment in a command', async () => {
    process.env['SERVICE_SECRET'] = 'leaked';
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    const { stdout } = await session.run({
      command: 'echo "[$SERVICE_SECRET]"; echo "$IS_SANDBOX $npm_config_side_effects_cache"',
    });

    expect(stdout).toBe('[]\n1 false\n');
    delete process.env['SERVICE_SECRET'];
  });

  it('reads and writes files, byte for byte', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);

    await session.writeBinaryFile({ path: 'deep/dir/data.bin', content: bytes });
    await session.writeTextFile({ path: 'lines.txt', content: 'a\nb\nc\n' });
    await session.writeFile({ path: 'stream.txt', content: new Blob(['streamed']).stream() });

    expect(await session.readBinaryFile({ path: 'deep/dir/data.bin' })).toEqual(bytes);
    expect(await session.readTextFile({ path: 'lines.txt', startLine: 2, endLine: 3 })).toBe(
      'b\nc',
    );
    expect(await new Response(await session.readFile({ path: 'stream.txt' })).text()).toBe(
      'streamed',
    );
    expect(await session.readFile({ path: 'missing.txt' })).toBeNull();
    expect(await session.readTextFile({ path: 'missing.txt' })).toBeNull();
    await expect(session.readBinaryFile({ path: 'deep' })).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('reports a file it cannot read or write', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    await session.writeTextFile({ path: 'locked/file.txt', content: 'x' });
    await session.run({ command: 'chmod 000 locked/file.txt && chmod 500 locked' });

    await expect(session.readTextFile({ path: 'locked/file.txt' })).rejects.toThrow(
      'Could not read',
    );
    await expect(session.writeTextFile({ path: 'locked/new.txt', content: 'x' })).rejects.toThrow(
      'Could not write',
    );
    await session.run({ command: 'chmod 700 locked' });
  });

  it('streams the output of a spawned process, and kills it with what it started', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    const spawned = await session.spawn({ command: 'echo started; sleep 30 & wait' });
    const reader = spawned.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('started\n');
    await spawned.kill();

    const { exitCode } = await spawned.wait();
    expect(exitCode).not.toBe(0);
    const { stdout } = await session.run({ command: 'pgrep -f "slee[p] 30" || echo none' });
    expect(stdout).toBe('none\n');
  });

  it('aborts a process, and refuses to start one already aborted', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    const controller = new AbortController();

    const spawned = await session.spawn({ command: 'sleep 30', abortSignal: controller.signal });
    controller.abort(new Error('stop'));

    await expect(spawned.wait()).rejects.toThrow('stop');
    await expect(session.run({ command: 'true', abortSignal: controller.signal })).rejects.toThrow(
      'stop',
    );
    await expect(
      session.readFile({ path: 'x', abortSignal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it('finds the exit code of a process whose stream broke off', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    const spawned = await session.spawn({ command: 'sleep 1; exit 7' });
    // A reader that gives up does not stop the process.
    await spawned.stdout.cancel();
    await spawned.stderr.cancel();

    expect(await spawned.wait()).toEqual({ exitCode: 7 });
  });

  it('describes itself to the agent, and gives tools a restricted view', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    expect(session.description).toContain('Cloud Run sandbox "box"');
    const restricted = session.restricted();
    expect(restricted).not.toHaveProperty('stop');
    expect((await restricted.run({ command: 'echo ok' })).stdout).toBe('ok\n');
  });
});

describe('the lifecycle of a Cloud Run sandbox', () => {
  let fake: FakeService;
  const options = (): { auth: 'none'; url: string } => ({ url: fake.url, auth: 'none' });

  beforeEach(async () => {
    fake = await startFakeService();
  });
  afterEach(() => fake.dispose());

  it('is suspended to a snapshot, and resumed from it with its files', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    await session.writeTextFile({ path: 'work.txt', content: 'kept' });

    await session.stop();
    await session.stop();

    expect(existsSync(join(fake.snapshots, 'snapshots/box.tar.gz'))).toBe(true);
    await expect(session.run({ command: 'true' })).rejects.toMatchObject({ status: 404 });
    const resumed = await resumeCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    expect(await resumed.readTextFile({ path: 'work.txt' })).toBe('kept');
    // A snapshot is spent once the sandbox is back.
    expect(existsSync(join(fake.snapshots, 'snapshots/box.tar.gz'))).toBe(false);
  });

  it('suspends and resumes through files, for a CLI that takes no pipe', async () => {
    process.env['FAKE_SANDBOX_NO_FIFO'] = '1';
    try {
      const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
      await session.writeTextFile({ path: 'work.txt', content: 'kept' });

      await session.stop();
      const resumed = await resumeCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

      expect(await resumed.readTextFile({ path: 'work.txt' })).toBe('kept');
    } finally {
      delete process.env['FAKE_SANDBOX_NO_FIFO'];
    }
  });

  it('runs a command in a working directory that does not exist, and says so', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    const result = await session.run({ command: 'true', workingDirectory: 'missing' });

    expect(result).toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining('missing') as unknown,
    });
  });

  it('resumes a running sandbox as it is', async () => {
    await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box', ports: [4000] });

    const resumed = await resumeCloudRunNetworkSandboxSession({
      ...options(),
      sandboxId: 'box',
      ports: [4000],
    });

    expect(resumed.ports).toEqual([4000]);
    expect((await resumed.run({ command: 'echo ok' })).stdout).toBe('ok\n');
  });

  it('cannot resume a sandbox that does not exist', async () => {
    await expect(
      resumeCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'ghost' }),
    ).rejects.toBeInstanceOf(CloudRunSandboxNotFoundError);
    await expect(
      resumeCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'Bad Name' }),
    ).rejects.toThrow('Invalid sandbox id');
    await expect(
      resumeCloudRunNetworkSandboxSession({
        ...options(),
        sandboxId: 'ghost',
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it('is destroyed with its snapshot, running or suspended', async () => {
    const running = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'one' });
    const suspended = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'two' });
    await suspended.stop();

    await running.destroy();
    await suspended.destroy();

    expect(existsSync(join(fake.snapshots, 'snapshots/two.tar.gz'))).toBe(false);
    await expect(
      resumeCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'one' }),
    ).rejects.toBeInstanceOf(CloudRunSandboxNotFoundError);
  });

  it('stops the processes of every session, those of a previous run included', async () => {
    const first = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    await started(await first.spawn({ command: 'echo started; sleep 31' }));
    const second = await resumeCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });

    await second.killAllProcesses();

    const { stdout } = await second.run({ command: 'pgrep -f "slee[p] 31" || echo none' });
    expect(stdout).toBe('none\n');
  });

  it('releases what a session holds, and keeps the sandbox running', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    await started(await session.spawn({ command: 'echo started; sleep 32' }));

    await session.release();

    const { stdout } = await session.run({ command: 'pgrep -f "slee[p] 32" || echo none' });
    expect(stdout).toBe('none\n');
  });

  it('saves the running sandboxes when the service stops', async () => {
    const session = await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'box' });
    await session.writeTextFile({ path: 'work.txt', content: 'saved' });

    await fake.service.sandboxes.suspendAll();

    expect(existsSync(join(fake.snapshots, 'snapshots/box.tar.gz'))).toBe(true);
  });
});

describe('a template', () => {
  let fake: FakeService;
  const options = (): { auth: 'none'; url: string } => ({ url: fake.url, auth: 'none' });

  beforeEach(async () => {
    fake = await startFakeService();
  });
  afterEach(() => fake.dispose());

  it('is prepared once, after the setup, and every later sandbox starts from it', async () => {
    const prepare = vi.fn<HarnessV1SandboxTemplate['prepare']>(async ({ session }) => {
      await session.run({ command: 'printf baked > "$HOME/baked.txt"' });
    });
    const template: HarnessV1SandboxTemplate = { identity: 'harness@1', prepare };
    const setup = ['echo set-up > "$HOME/setup.txt"'];

    const [first, second] = await Promise.all([
      createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'one', template, setup }),
      createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'two', template, setup }),
    ]);

    expect(prepare).toHaveBeenCalledOnce();
    const id = templateId({ template, setup });
    expect(existsSync(join(fake.snapshots, `templates/test/${id}.tar.gz`))).toBe(true);
    for (const session of [first, second]) {
      const { stdout } = await session.run({ command: 'cat "$HOME/baked.txt" "$HOME/setup.txt"' });
      expect(stdout).toBe('bakedset-up\n');
    }
    expect(fake.calls().filter(([command]) => command === 'run')).toHaveLength(3);
  });

  it('gets an id of its own for each harness version and setup', () => {
    const template = (identity: string): HarnessV1SandboxTemplate => ({
      identity,
      prepare: () => Promise.resolve(),
    });

    const id = templateId({ template: template('a'), setup: [] });

    expect(id).toMatch(/^ai-sdk-harness-template-[0-9a-f]{24}$/);
    expect(templateId({ template: template('b'), setup: [] })).not.toBe(id);
    expect(templateId({ template: template('a'), setup: ['x'] })).not.toBe(id);
  });

  it('is built again when the first build failed', async () => {
    let attempts = 0;
    const template: HarnessV1SandboxTemplate = {
      identity: 'flaky',
      prepare: () => (++attempts === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve()),
    };

    await expect(
      createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'one', template }),
    ).rejects.toThrow('flaky');
    await createCloudRunNetworkSandboxSession({ ...options(), sandboxId: 'one', template });

    expect(attempts).toBe(2);
  });
});

describe('the network of a Cloud Run sandbox', () => {
  let fake: FakeService;
  let upstream: ReturnType<typeof createServer>;
  let received: { headers: IncomingHttpHeaders; url: string }[];
  let upstreamUrl: string;

  beforeEach(async () => {
    received = [];
    upstream = createServer((request, response) => {
      received.push({ url: request.url ?? '', headers: request.headers });
      response.end('from upstream');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api`;
    fake = await startFakeService({
      network: { allowedHosts: [], baseUrls: { MODEL_BASE_URL: upstreamUrl } },
    });
  });
  afterEach(async () => {
    await fake.dispose();
    await new Promise((resolve) => upstream.close(resolve));
  });

  /** Fetches `$<variable>/<path>` in the sandbox, with `authorization`, and prints the answer. */
  const fetchFrom = (variable: string, path: string): string =>
    node(
      `fetch(process.env.${variable} + "${path}", { headers: { authorization: "Bearer placeholder" } })` +
        '.then(async (r) => console.log(r.status, await r.text()))',
    );

  it('routes the base URLs through the relay, and swaps the placeholder for the credential', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations?.([anthropicTransformation('placeholder')]);

    const { stdout } = await session.run({
      command: `echo $MODEL_BASE_URL; ${fetchFrom('MODEL_BASE_URL', '/v1/messages?beta=1')}`,
    });

    const [routed, answer] = stdout.trim().split('\n');
    expect(routed).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/http\/127\.0\.0\.1:\d+\/api$/);
    expect(answer).toBe('200 from upstream');
    expect(received).toEqual([
      expect.objectContaining({
        url: '/api/v1/messages?beta=1',
        headers: expect.objectContaining({ authorization: 'Bearer real-token' }) as unknown,
      }),
    ]);
  });

  it('routes a base URL a command sets itself, and replaces the credentials when asked', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations?.([anthropicTransformation('placeholder')]);
    await session.setRequestTransformations?.([]);

    const { stdout } = await session.run({
      command: fetchFrom('MODEL_BASE_URL', '/x'),
      env: { MODEL_BASE_URL: upstreamUrl },
    });

    expect(stdout).toBe('200 from upstream\n');
    expect(received[0]?.headers['authorization']).toBe('Bearer placeholder');
  });

  it('takes base URLs from the caller, on top of the service', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      baseUrls: { OTHER_BASE_URL: upstreamUrl },
    });

    const { stdout } = await session.run({ command: fetchFrom('OTHER_BASE_URL', '/y') });

    expect(stdout).toBe('200 from upstream\n');
  });

  it('refuses a host that is neither allowed nor a base URL', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    const port = (upstream.address() as AddressInfo).port;

    const { stdout } = await session.run({
      command: `${fetchFrom('HTTP_PROXY', `/http/localhost:${port}/`)}; ${node(
        'require("http").request({ host: "127.0.0.1", port: new URL(process.env.HTTPS_PROXY).port, method: "CONNECT", path: "github.com:443" })' +
          '.on("connect", (r) => { console.log(r.statusCode); process.exit(0); }).end()',
      )}; ${fetchFrom('HTTP_PROXY', '/not-a-route')}`,
    });

    expect(stdout).toBe(
      '403 localhost is not reachable from the sandbox.\n\n403\n' +
        '403 Only HTTPS through the proxy, or a base URL route, leaves the sandbox.\n\n',
    );
    expect(received).toEqual([]);
  });

  it('lets a network policy open more hosts, or none', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    const port = (upstream.address() as AddressInfo).port;
    const toLocalhost = fetchFrom('HTTP_PROXY', `/http/localhost:${port}/z`);

    await session.setNetworkPolicy({ mode: 'custom', allowedHosts: ['localhost'] });
    expect((await session.run({ command: toLocalhost })).stdout).toBe('200 from upstream\n');
    await session.setNetworkPolicy({ mode: 'deny-all' });
    expect((await session.run({ command: toLocalhost })).stdout).toMatch(/^403/);
    await session.setNetworkPolicy({ mode: 'allow-all' });
    expect((await session.run({ command: toLocalhost })).stdout).toBe('200 from upstream\n');
    await expect(
      session.setNetworkPolicy({ mode: 'custom', allowedCIDRs: ['10.0.0.0/8'] }),
    ).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
  });

  it('answers 502 when a base URL cannot be reached, and drops a tunnel that cannot open', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['localhost'],
      baseUrls: { DEAD_BASE_URL: `http://127.0.0.1:${await freePort()}` },
    });
    const connect =
      'require("http").request({ host: "127.0.0.1", port: new URL(process.env.HTTPS_PROXY).port, method: "CONNECT", path: "localhost:443" })' +
      '.on("connect", (r) => console.log(r.statusCode)).on("error", () => console.log("dropped")).end()';

    const { stdout } = await session.run({
      command: `${fetchFrom('DEAD_BASE_URL', '/')}; ${node(connect)}`,
    });

    expect(stdout).toMatch(/^502 connect ECONNREFUSED 127\.0\.0\.1:\d+\n\ndropped\n$/);
  });

  it('always brokers the credentials: a harness never forwards one into the sandbox', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });

    expect(session.addRequestTransformations).toBeTypeOf('function');
    expect(session.setRequestTransformations).toBeTypeOf('function');
  });
});

describe('the ports of a Cloud Run sandbox', () => {
  let fake: FakeService;

  beforeEach(async () => {
    fake = await startFakeService();
  });
  afterEach(() => fake.dispose());

  /** Sends an upgrade request through the tunnel and reads what comes back, up to `until`. */
  async function upgrade(url: string, until: RegExp): Promise<string> {
    const { port, pathname } = new URL(url);
    const socket = connect({ host: '127.0.0.1', port: Number(port) });
    socket.write(
      `GET ${pathname}/path?q=1 HTTP/1.1\r\nHost: service\r\nUpgrade: echo\r\nConnection: Upgrade\r\nAuthorization: Bearer secret\r\n\r\nping`,
    );
    let answer = '';
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      answer += chunk.toString();
      if (until.test(answer)) break;
    }
    socket.destroy();
    return answer;
  }

  it('reaches a port of the sandbox through the service, without the caller credentials', async () => {
    const port = await freePort();
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      ports: [port],
    });
    await session.spawn({
      command: node(
        'require("http").createServer().on("upgrade", (req, socket, head) => {' +
          'socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n");' +
          'socket.write(JSON.stringify({ url: req.url, authorization: req.headers.authorization ?? null }) + "\\n");' +
          'socket.write(head); socket.pipe(socket); })' +
          `.listen(${port}, "127.0.0.1", () => console.log("listening"))`,
      ),
    });
    await vi.waitFor(async () => {
      expect(
        (
          await session.run({
            command: `node -e 'require("net").connect(${port}).on("connect", () => process.exit(0)).on("error", () => process.exit(1))'`,
          })
        ).exitCode,
      ).toBe(0);
    });

    const endpoint = await session.getPortEndpoint({ port, protocol: 'ws' });
    const answer = await upgrade(endpoint.url, /ping/);

    expect(endpoint.url).toBe(`${fake.url.replace('http', 'ws')}/v1/sandboxes/box/ports/${port}`);
    expect(endpoint.headers).toEqual({ 'x-ai-sdk-sandbox-protocol': '1' });
    expect(answer).toContain('101 Switching Protocols');
    expect(answer).toContain(`{"url":"/path?q=1","authorization":null}`);
    expect(answer).toMatch(/ping$/);
    expect(await session.getPortUrl({ port })).toBe(`${fake.url}/v1/sandboxes/box/ports/${port}`);
  });

  it('refuses a port it does not expose, and one of a sandbox that does not run', async () => {
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      ports: [4000],
    });

    await expect(session.getPortEndpoint({ port: 5000 })).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
    await session.setPorts([5000]);
    expect(session.ports).toEqual([5000]);
    expect(await upgrade(`${fake.url}/v1/sandboxes/ghost/ports/4000`, /\r\n\r\n/)).toContain('404');
    expect(await upgrade(`${fake.url}/v1/sandboxes/box/ports/99999`, /\r\n\r\n/)).toContain('404');
  });
});
