import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { AddressInfo } from 'node:net';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { FakeService } from '../test/fake-service.js';
import type { GitServer } from '../test/git-server.js';

import { startFakeService } from '../test/fake-service.js';
import { readRules, startGitServer } from '../test/git-server.js';
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

  it('never hands back a credential an API echoes in its response headers', async () => {
    upstream = createServer((request, response) => {
      response.setHeader('x-echo', String(request.headers['x-api-key']));
      response.end('echoed');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    port = (upstream.address() as AddressInfo).port;
    // Plain HTTP to the loopback, as a local run allows: the credential is put in all the same.
    fake = await startFakeService({
      allowPrivateNetwork: true,
      network: { allowedHosts: [], baseUrls: {} },
    });
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
    });
    await session.addRequestTransformations?.([
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
      'This client speaks protocol 99 of ai-sdk-sandbox-cloud-run, this service 2',
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

describe('a credential brokered to read a Git repository', () => {
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;
  const TOKEN = 'ghs_read_only_token_0123456789';
  const placeholder = basic('x-access-token:ai-sdk-harness-1b4e28ba-2fa1-41d2-883f-0016d3cca427');
  let fake: FakeService;
  let server: GitServer;

  afterEach(async () => {
    await fake.dispose();
    await server.close();
  });

  /**
   * A sandbox whose checkout has what `gitRepository({ readOnlyRemote })` of
   * `ai-sdk-harness-workspace` leaves it: an `origin` remote, git sending a placeholder, the rules
   * of a read registered. Git goes through the relay's routes, plain HTTP to the loopback here.
   */
  async function sandboxWithRemote() {
    server = await startGitServer(basic(`x-access-token:${TOKEN}`));
    fake = await startFakeService({
      allowPrivateNetwork: true,
      network: { allowedHosts: [], baseUrls: {} },
    });
    const session = await createCloudRunNetworkSandboxSession({
      url: fake.url,
      auth: 'none',
      sandboxId: 'box',
      allowedHosts: ['localhost'],
    });
    expect(session.credentialBrokering).toEqual({ scope: 'request' });
    expect(session.fork({ ports: [] }).credentialBrokering).toEqual({ scope: 'request' });
    await session.addRequestTransformations?.(
      readRules('127.0.0.1', '/acme/api', placeholder, basic(`x-access-token:${TOKEN}`)),
    );
    const remote = `http://127.0.0.1:${server.port}/acme/api.git`;
    const { exitCode, stderr } = await session.run({
      command: [
        'git init --quiet repo',
        'cd repo',
        `git remote add origin ${remote}`,
        `git config http.extraHeader "Authorization: ${placeholder}"`,
        'git config url."$HTTP_PROXY/http/".insteadOf http://',
      ].join(' && '),
    });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    return session;
  }

  /** A request through the relay's route to the Git server, the placeholder in it: its status. */
  const sendPlaceholder = (path: string, method = 'GET', host = '127.0.0.1') =>
    node(
      `fetch(process.env.HTTP_PROXY + "/http/${host}:${server.port}${path}", { method: "${method}", headers: { authorization: "${placeholder}" } })` +
        '.then(async (r) => console.log(r.status, (await r.text()).split("\\n")[0]))',
    );

  it('routes git over HTTPS through the relay, where the service reads its requests', async () => {
    const session = await sandboxWithRemote();

    const { stdout } = await session.run({
      command: 'git ls-remote --get-url https://github.com/acme/api.git',
    });

    expect(stdout.trim()).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/https\/github\.com\/acme\/api\.git$/,
    );
  });

  it('reads the repository with the token, which never enters the sandbox, and refuses a push', async () => {
    const session = await sandboxWithRemote();

    const fetched = await session.run({
      command:
        'cd repo && git fetch --quiet origin && git rev-parse origin/main && git ls-remote origin main',
      workingDirectory: '.',
    });
    const pushed = await session.run({
      command:
        'cd repo && git checkout --quiet -b x origin/main && git push origin HEAD:refs/heads/x',
    });

    expect(fetched.stdout.split('\n')[0]).toBe(server.head);
    expect(fetched.stdout).toContain(`${server.head}\trefs/heads/main`);
    expect(pushed.exitCode).not.toBe(0);
    expect(pushed.stderr).toMatch(/403/);
    // What reached the Git server: reads, with the token, and nothing else.
    expect(server.requests.length).toBeGreaterThan(0);
    for (const { path, authorization } of server.requests) {
      expect(path).toMatch(
        /^\/acme\/api\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
      );
      expect(authorization).toBe(basic(`x-access-token:${TOKEN}`));
    }
    const { stdout: config } = await session.run({ command: 'cd repo && git config --list; env' });
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(basic(`x-access-token:${TOKEN}`));
  });

  it('refuses the placeholder wherever no rule of it applies: a push, another repository, another host', async () => {
    const session = await sandboxWithRemote();

    const { stdout } = await session.run({
      command: [
        sendPlaceholder('/acme/api.git/git-receive-pack', 'POST'),
        sendPlaceholder('/acme/api.git/info/refs?service=git-receive-pack'),
        sendPlaceholder('/acme/api.git/info/refs?service=git-upload-pack&service=git-receive-pack'),
        sendPlaceholder('/acme/api.git/info/refs?service=git-receive-pack&service=git-upload-pack'),
        sendPlaceholder('/acme/api-other.git/info/refs?service=git-upload-pack'),
        sendPlaceholder('//acme/api.git/info/refs?service=git-upload-pack'),
        sendPlaceholder('/acme/api.git/git-upload-pack', 'PUT'),
        sendPlaceholder('/acme/api.git/info/lfs/objects/batch', 'POST'),
        sendPlaceholder('/acme/api.git/info/refs?service=git-upload-pack', 'GET', 'localhost'),
        sendPlaceholder('/acme/api.git/info/refs?service=git-upload-pack'),
      ].join('; '),
    });

    const refused =
      '403 The request carries a credential placeholder of the sandbox where no rule of its credential brokering applies (another host, path, method or query): the sandbox may not use that credential here. A credential brokered to read a Git repository never lets it push.';
    expect(stdout.trim().split('\n')).toEqual([
      ...Array.from({ length: 9 }, () => refused),
      '200 001e# service=git-upload-pack',
    ]);
    // Only the read the rules cover reached the server.
    expect(server.requests.map(({ path }) => path)).toEqual([
      '/acme/api.git/info/refs?service=git-upload-pack',
    ]);
  });

  it('renews the token in place: the rules for the same placeholder replace the ones before', async () => {
    const session = await sandboxWithRemote();
    const renewed = basic('x-access-token:ghs_renewed_token_9876543210');

    await session.addRequestTransformations?.(
      readRules('127.0.0.1', '/acme/api', placeholder, renewed),
    );
    server.accepted = renewed;
    const { stdout, exitCode } = await session.run({
      command: 'cd repo && git fetch --quiet origin && git rev-parse origin/main',
    });

    expect({ exitCode, stdout: stdout.trim() }).toEqual({ exitCode: 0, stdout: server.head });
    const { transformations } = fake.service.sandboxes.get('box');
    expect(transformations).toHaveLength(4);
    expect(transformations.map(({ transform }) => transform.headers['Authorization'])).toEqual(
      Array.from({ length: 4 }, () => renewed),
    );
  });
});
