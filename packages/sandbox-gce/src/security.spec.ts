import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { AddressInfo } from 'node:net';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { FakeService } from '../test/fake-service.js';

import { startFakeService } from '../test/fake-service.js';
import { createGceNetworkSandboxSession } from './index.js';
import { agentToken } from './server/sandboxes/agent-client.js';

/** A credential as a harness hands it over: the placeholder the sandbox sees, the real value. */
const SECRET = 'sk-ant-real-secret-0123456789';
const credential: HarnessV1RequestTransformation = {
  match: {
    host: 'api.anthropic.com',
    headers: [{ key: { exact: 'x-api-key' }, value: { exact: 'aisdkhc_placeholder' } }],
  },
  transform: { headers: { 'x-api-key': SECRET } },
};

/** A Node.js one-liner, run in the sandbox. */
const node = (code: string): string => `node -e '${code}'`;

/** A CONNECT through the sandbox's proxy, printing its status or that the tunnel was dropped. */
const connectTo = (target: string): string =>
  node(
    `require("http").request({ host: "127.0.0.1", port: new URL(process.env.HTTPS_PROXY).port, method: "CONNECT", path: "${target}" })` +
      '.on("connect", (r) => { console.log(r.statusCode); process.exit(0); }).on("error", () => console.log("dropped")).end()',
  );

/** A TLS connection naming `servername`, in a tunnel to `target` through the sandbox's proxy. */
const tlsTo = (target: string, servername: string): string =>
  node(
    `require("http").request({ host: "127.0.0.1", port: new URL(process.env.HTTPS_PROXY).port, method: "CONNECT", path: "${target}" })` +
      `.on("connect", (r, socket) => require("tls").connect({ socket, servername: "${servername}" }).on("error", () => undefined).on("close", () => process.exit(0))).end()`,
  );

/** A plain request to the proxy under `path`, printing the status and the body. */
const fetchProxy = (path: string): string =>
  node(
    `fetch(process.env.HTTP_PROXY + "${path}").then(async (r) => console.log(r.status, (await r.text()).trim()))`,
  );

/** Sends a raw upgrade request to `port` of the loopback, and reads the answer to its end. */
async function upgrade(port: number, request: string): Promise<string> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.write(request);
  let answer = '';
  for await (const chunk of socket as AsyncIterable<Buffer>) answer += chunk.toString();
  return answer;
}

describe('a sandbox machine', () => {
  let fake: FakeService;

  afterEach(() => fake.dispose());

  it('has no external address, no service account and no credential of the service', async () => {
    fake = await startFakeService();
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations([credential]);

    const body = fake.compute.instance('sbx-box')?.body ?? {};

    expect(body['serviceAccounts']).toEqual([]);
    expect(body['networkInterfaces']).toEqual([{}]);
    expect(body['labels']).toEqual({
      'ai-sdk-sandbox': 'sandbox',
      'ai-sdk-sandbox-image': 'default',
    });
    const metadata = JSON.stringify(body['metadata']);
    expect(metadata).not.toContain(SECRET);
    expect(metadata).not.toContain('a-secret-of-thirty-two-characters!');
    expect(metadata).toContain(agentToken('a-secret-of-thirty-two-characters!', 'sbx-box'));
  });

  it('has an agent that only answers the token derived for its machine', async () => {
    fake = await startFakeService();
    await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      ports: [4000],
    });
    const port = fake.compute.agentPort('sbx-box');
    const other = agentToken('a-secret-of-thirty-two-characters!', 'sbx-other');
    const exec = (headers: Record<string, string>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/v1/exec`, {
        method: 'POST',
        headers,
        body: '{"command":"echo pwned"}\n',
      });

    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect((await exec({})).status).toBe(401);
    expect((await exec({ 'x-ai-sdk-sandbox-agent-token': other })).status).toBe(401);
    expect(
      await upgrade(
        port,
        'GET /v1/ports/4000 HTTP/1.1\r\nHost: x\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n',
      ),
    ).toMatch(/^HTTP\/1.1 401/);
  });
});

describe('credentials', () => {
  let fake: FakeService;

  afterEach(() => fake.dispose());

  it('are refused on their way into the sandbox, in a variable or a command', async () => {
    fake = await startFakeService();
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations([credential]);

    await expect(
      session.run({ command: 'true', env: { ANTHROPIC_API_KEY: SECRET } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(session.run({ command: `echo ${SECRET} > leak.txt` })).rejects.toThrow(
      'Credentials stay outside the sandbox',
    );
    // The placeholder, which is what the sandbox is meant to see, goes through.
    const placeholder = await session.run({
      command: 'echo "$KEY"',
      env: { KEY: 'aisdkhc_placeholder' },
    });
    expect(placeholder.stdout).toBe('aisdkhc_placeholder\n');
  });

  it('are dropped from the proxy when the session releases the sandbox, or stops it', async () => {
    fake = await startFakeService();
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations([credential]);
    expect(fake.registry.holdsSecret('box', [SECRET])).toBe(true);

    await session.release();
    expect(fake.registry.holdsSecret('box', [SECRET])).toBe(false);

    await session.addRequestTransformations([credential]);
    await session.stop();
    expect(fake.registry.holdsSecret('box', [SECRET])).toBe(false);
    expect(fake.registry.policyFor('127.0.0.1')).toBeUndefined();
  });
});

describe('the egress proxy', () => {
  let fake: FakeService;
  let upstream: ReturnType<typeof createServer>;
  let port: number;

  afterEach(async () => {
    await fake.dispose();
    await new Promise((resolve) => upstream.close(resolve));
  });

  /** The proxy as on Google Cloud: private networks closed, whatever the sandbox may reach. */
  async function closedService(): Promise<FakeService> {
    upstream = createServer((_request, response) => response.end('reached'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as AddressInfo).port;
    return startFakeService({
      allowPrivateNetwork: false,
      network: { allowedHosts: [], baseUrls: {} },
    });
  }

  it('never reaches a private address, however it is named or allowed', async () => {
    fake = await closedService();
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['*'],
    });

    const { stdout } = await session.run({
      command: [
        fetchProxy(`/https/127.0.0.1:${port}/`),
        fetchProxy(`/https/169.254.169.254/computeMetadata/v1/`),
        fetchProxy(`/https/localhost:${port}/`),
        connectTo('127.0.0.1:443'),
        connectTo('localhost:443'),
      ].join('; '),
    });

    expect(stdout.trim().split('\n')).toEqual([
      '403 127.0.0.1 is a private address, out of reach of the sandbox.',
      '403 169.254.169.254 is a private address, out of reach of the sandbox.',
      expect.stringMatching(/^502 localhost resolves to a private address/),
      '403',
      'dropped',
    ]);
  });

  it('cuts a tunnel whose TLS names another server than its host, as a CDN serves many', async () => {
    const received: string[] = [];
    const tls = createTcpServer((socket) =>
      socket.once('data', (bytes) => {
        received.push(bytes[0] === 22 ? 'tls' : 'other');
        socket.destroy();
      }),
    );
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
    upstream = createServer();
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    fake = await startFakeService({
      network: { allowedHosts: [], baseUrls: {} },
      tunnelPort: (tls.address() as AddressInfo).port,
    });
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['localhost'],
    });

    await session.run({ command: tlsTo('localhost:443', 'attacker.workers.dev') });
    await session.run({ command: tlsTo('localhost:443', 'localhost') });
    await new Promise((resolve) => tls.close(resolve));

    expect(received).toEqual(['tls']);
  });

  it('refuses a machine that holds no sandbox, such as one stopped', async () => {
    fake = await closedService();
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['*'],
    });
    await session.stop();

    const response = await fetch(`${fake.proxyUrl}/https/example.com/`);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('This machine is no sandbox the proxy serves.\n');
  });

  it('never hands back a credential an API echoes in its response headers', async () => {
    upstream = createServer((request, response) => {
      response.setHeader('x-echo', String(request.headers['x-api-key']));
      response.end('echoed');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as AddressInfo).port;
    // Plain HTTP to the loopback, as a local run allows: the credential is put in all the same.
    fake = await startFakeService({ network: { allowedHosts: [], baseUrls: {} } });
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations([
      { ...credential, match: { ...credential.match, host: '127.0.0.1' } },
    ]);

    const { stdout } = await session.run({
      command: node(
        `fetch(process.env.HTTP_PROXY + "/http/127.0.0.1:${port}/", { headers: { "x-api-key": "aisdkhc_placeholder" } })` +
          '.then(async (r) => console.log(r.status, r.headers.get("x-echo"), await r.text()))',
      ),
    });

    expect(stdout).toBe('200 null echoed\n');
  });

  it('passes plain HTTP on to an allowed host only, with no credential put in', async () => {
    let received: string | undefined;
    upstream = createServer((request, response) => {
      received = String(request.headers['x-api-key']);
      response.end('mirror');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as AddressInfo).port;
    fake = await startFakeService({ network: { allowedHosts: [], baseUrls: {} } });
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['localhost'],
    });
    await session.addRequestTransformations([
      { ...credential, match: { ...credential.match, host: 'localhost' } },
    ]);
    const through = (host: string): string =>
      node(
        `require("http").get({ host: "127.0.0.1", port: new URL(process.env.HTTP_PROXY).port, path: "http://${host}:${port}/", headers: { "x-api-key": "aisdkhc_placeholder" } }, ` +
          '(r) => { let body = ""; r.on("data", (c) => (body += c)).on("end", () => console.log(r.statusCode, body.trim())); })',
      );

    const { stdout } = await session.run({
      command: `${through('localhost')}; ${through('127.0.0.1')}`,
    });

    expect(stdout).toBe(
      '200 mirror\n403 Only HTTPS through the proxy, or a base URL route, leaves the sandbox.\n',
    );
    expect(received).toBe('aisdkhc_placeholder');
  });

  it('only sends credentials over HTTPS', async () => {
    fake = await closedService();
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['*'],
    });

    const { stdout } = await session.run({ command: fetchProxy(`/http/example.com/`) });

    expect(stdout).toBe(
      '403 A base URL must be HTTPS: the credentials it carries never travel in clear.\n',
    );
  });
});

describe('the service', () => {
  let fake: FakeService;

  afterEach(() => fake.dispose());

  it('refuses a client speaking another protocol, with a message saying what to do', async () => {
    fake = await startFakeService();

    const response = await fetch(`${fake.url}/v1/sandboxes`, {
      method: 'POST',
      headers: { 'x-ai-sdk-sandbox-protocol': '99' },
      body: JSON.stringify({ name: 'box' }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      'This client speaks protocol 99 of ai-sdk-sandbox-gce, this service 2',
    );
  });

  it('demands its token, when it has one, of every call and every tunnel', async () => {
    fake = await startFakeService({ serviceToken: 'shared-secret' });

    await expect(
      createGceNetworkSandboxSession({ url: fake.url, auth: 'none', sandboxId: 'box' }),
    ).rejects.toBeInstanceOf(HarnessSandboxAuthenticationError);
    const session = await createGceNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      serviceToken: 'shared-secret',
      ports: [4000],
    });
    expect((await session.run({ command: 'echo ok' })).stdout).toBe('ok\n');
    expect((await session.getPortEndpoint({ port: 4000 })).headers).toMatchObject({
      'x-ai-sdk-sandbox-token': 'shared-secret',
    });
    expect((await fetch(`${fake.url}/health`)).status).toBe(200);

    const answer = await upgrade(
      Number(new URL(fake.url).port),
      'GET /v1/sandboxes/box/ports/4000 HTTP/1.1\r\nHost: x\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n',
    );
    expect(answer).toMatch(/^HTTP\/1.1 401/);
  });

  it('refuses a name a Compute Engine instance could not take', async () => {
    fake = await startFakeService();

    const response = await fetch(`${fake.url}/v1/sandboxes`, {
      method: 'POST',
      body: JSON.stringify({ name: `${'a'.repeat(59)}x` }),
    });

    expect(response.status).toBe(400);
    expect(fake.compute.calls).toEqual([]);
  });
});
