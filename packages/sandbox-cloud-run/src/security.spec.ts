import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { AddressInfo } from 'node:net';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { FakeService } from '../test/fake-service.js';

import { startFakeService } from '../test/fake-service.js';
import { createCloudRunNetworkSandboxSession } from './index.js';

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

/** A plain request to the relay under `path`, printing the status and the body. */
const fetchRelay = (path: string): string =>
  node(
    `fetch(process.env.HTTP_PROXY + "${path}").then(async (r) => console.log(r.status, (await r.text()).trim()))`,
  );

describe('credentials', () => {
  let fake: FakeService;

  afterEach(() => fake.dispose());

  it('never appear on the command line Cloud Run logs, nor do commands or variables', async () => {
    fake = await startFakeService();
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations([credential]);

    const { stdout } = await session.run({
      command: 'echo "command-marker $TOKEN_VARIABLE"',
      env: { TOKEN_VARIABLE: 'variable-marker' },
    });

    expect(stdout).toBe('command-marker variable-marker\n');
    const logged = JSON.stringify(fake.calls());
    expect(logged).not.toContain('command-marker');
    expect(logged).not.toContain('variable-marker');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('ANTHROPIC_BASE_URL');
  });

  it('are refused on their way into the sandbox, in a variable or a command', async () => {
    fake = await startFakeService();
    const session = await createCloudRunNetworkSandboxSession({
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

  it('are dropped from the service when the session releases the sandbox', async () => {
    fake = await startFakeService();
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations([credential]);

    await session.release();

    expect(fake.service.sandboxes.get('box').transformations).toEqual([]);
  });
});

describe('the network of a sandbox on Cloud Run', () => {
  let fake: FakeService;
  let upstream: ReturnType<typeof createServer>;
  let port: number;

  afterEach(async () => {
    await fake.dispose();
    await new Promise((resolve) => upstream.close(resolve));
  });

  /** The service as on Cloud Run: private networks closed, whatever the sandbox may reach. */
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
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['*'],
    });

    const { stdout } = await session.run({
      command: [
        fetchRelay(`/https/127.0.0.1:${port}/`),
        fetchRelay(`/https/169.254.169.254/computeMetadata/v1/`),
        fetchRelay(`/https/localhost:${port}/`),
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

  it('only sends credentials over HTTPS', async () => {
    fake = await closedService();
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['*'],
    });

    const { stdout } = await session.run({ command: fetchRelay(`/http/example.com/`) });

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
      'This client speaks protocol 99 of ai-sdk-sandbox-cloud-run, this service 1',
    );
  });

  it('demands its token, when it has one, of every call and every tunnel', async () => {
    fake = await startFakeService({ serviceToken: 'shared-secret' });

    await expect(
      createCloudRunNetworkSandboxSession({ url: fake.url, auth: 'none', sandboxId: 'box' }),
    ).rejects.toBeInstanceOf(HarnessSandboxAuthenticationError);
    const session = await createCloudRunNetworkSandboxSession({
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

    const { port } = new URL(fake.url);
    const socket = connect({ host: '127.0.0.1', port: Number(port) });
    socket.write(
      'GET /v1/sandboxes/box/ports/4000 HTTP/1.1\r\nHost: x\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n',
    );
    let answer = '';
    for await (const chunk of socket as AsyncIterable<Buffer>) answer += chunk.toString();
    expect(answer).toMatch(/^HTTP\/1.1 401/);
  });
});
