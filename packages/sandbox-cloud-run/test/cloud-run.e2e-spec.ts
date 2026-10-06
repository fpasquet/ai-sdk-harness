import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { afterAll, describe, expect, it } from 'vitest';

import type { CloudRunAuth, CloudRunNetworkSandboxSession } from '../src/index.js';

import { identityToken } from '../src/identity-token.js';
import {
  createCloudRunNetworkSandboxSession,
  resumeCloudRunNetworkSandboxSession,
} from '../src/index.js';
import { SandboxServiceClient } from '../src/sandbox-service-client.js';
import { templateId } from '../src/sandbox-template.js';

/**
 * Against a sandbox service deployed on Cloud Run: set CLOUD_RUN_SANDBOX_URL to its URL, and have
 * gcloud signed in with an account granted roles/run.invoker on it (or set CLOUD_RUN_SANDBOX_AUTH
 * to `none` for a service run locally). Every sandbox and template it makes is removed at the end.
 */
const url = process.env['CLOUD_RUN_SANDBOX_URL'];

/**
 * A server on port 4000 that accepts a WebSocket upgrade and answers with the headers it got, then
 * closes: enough to see what goes through the tunnel. Cloud Run's front end only lets WebSocket
 * upgrades through.
 */
const WS_SERVER = `
const { createHash } = require('node:crypto');
require('node:http').createServer().on('upgrade', (request, socket) => {
  const accept = createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.end(
    'HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n' +
      'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n' + JSON.stringify(request.headers),
  );
}).listen(4000, '127.0.0.1');
`;
const auth = (process.env['CLOUD_RUN_SANDBOX_AUTH'] ?? 'gcloud') as CloudRunAuth;
const run = randomBytes(3).toString('hex');
const sessions: CloudRunNetworkSandboxSession[] = [];
const template: HarnessV1SandboxTemplate = {
  identity: `e2e-${run}`,
  prepare: async ({ session }) => {
    const { exitCode } = await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    expect(exitCode).toBe(0);
  },
};

describe.skipIf(url === undefined)('a sandbox on Cloud Run', () => {
  const options = {
    url: url ?? '',
    auth,
    allowedHosts: ['registry.npmjs.org'],
    ports: [4000],
    serviceToken: process.env['CLOUD_RUN_SANDBOX_SERVICE_TOKEN'],
  };
  let session: CloudRunNetworkSandboxSession;

  afterAll(async () => {
    await Promise.all(sessions.map((created) => created.destroy()));
    const client = new SandboxServiceClient(options.url, {
      token: identityToken(auth, options.url),
    });
    await client.deleteTemplate(templateId({ template, setup: [] }));
  });

  it('is created from a template, with no network but what is allowed', async () => {
    session = await createCloudRunNetworkSandboxSession({
      ...options,
      sandboxId: `ai-sdk-e2e-${run}`,
      template,
    });
    sessions.push(session);

    const { stdout } = await session.run({ command: 'cat "$HOME/baked.txt"; whoami' });
    expect(stdout).toBe('baked\nroot\n');

    const npm = await session.run({ command: 'npm view left-pad version' });
    expect(npm.exitCode).toBe(0);
    const github = await session.run({ command: 'curl -sS -o /dev/null https://github.com' });
    expect(github.exitCode).not.toBe(0);
  });

  it('hands back exit codes and files as they are', async () => {
    expect((await session.run({ command: 'exit 44' })).exitCode).toBe(44);

    const bytes = new Uint8Array(256).map((_, index) => index);
    await session.writeBinaryFile({ path: 'bytes.bin', content: bytes });
    expect(await session.readBinaryFile({ path: 'bytes.bin' })).toEqual(bytes);
  });

  it('puts a credential in on the way out, without it ever entering the sandbox', async () => {
    const secret = `e2e-secret-${run}-0123456789`;
    const echo = await createCloudRunNetworkSandboxSession({
      ...options,
      sandboxId: `ai-sdk-e2e-echo-${run}`,
      baseUrls: { ECHO_BASE_URL: 'https://postman-echo.com' },
    });
    sessions.push(echo);
    await echo.addRequestTransformations([
      {
        match: {
          host: 'postman-echo.com',
          headers: [{ key: { exact: 'x-api-key' }, value: { exact: 'aisdkhc_e2e' } }],
        },
        transform: { headers: { 'x-api-key': secret } },
      },
    ]);

    const { stdout } = await echo.run({
      command:
        'node -e \'fetch(process.env.ECHO_BASE_URL + "/headers", { headers: { "x-api-key": "aisdkhc_e2e" } })' +
        '.then((r) => r.json()).then((b) => console.log(b.headers["x-api-key"]))\'; env',
    });

    const [echoed, ...environment] = stdout.trim().split('\n');
    expect(echoed).toBe(secret);
    expect(environment.join('\n')).not.toContain(secret);
    await expect(echo.run({ command: 'true', env: { KEY: secret } })).rejects.toThrow(
      'Credentials stay outside the sandbox',
    );
  });

  it('keeps the metadata server and private addresses out of reach', async () => {
    const { stdout } = await session.run({
      command: [
        'curl -s -m 5 -o /dev/null -w "%{http_code}\\n" -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/ || echo failed',
        'curl -s -m 5 -w "\\n" "$HTTP_PROXY/https/169.254.169.254/computeMetadata/v1/"',
      ].join('; '),
    });

    const [direct, routed] = stdout.trim().split('\n');
    expect(direct).not.toBe('200');
    expect(routed).toMatch(/^169\.254\.169\.254 is (not reachable|a private address)/);
  });

  it('reaches a port of the sandbox through the service, without the caller credentials', async () => {
    await session.writeTextFile({ path: 'ws-server.js', content: WS_SERVER });
    await session.spawn({ command: 'node ws-server.js' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const endpoint = await session.getPortEndpoint({ port: 4000, protocol: 'https' });

    const received = await new Promise<string>((resolve, reject) => {
      const request = httpsRequest(endpoint.url, {
        headers: {
          ...endpoint.headers,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      request.on('upgrade', (_response, socket, head) => {
        let body = head.toString();
        socket.on('data', (chunk: Buffer) => (body += chunk.toString()));
        socket.on('close', () => resolve(body));
      });
      request.on('response', (response) => reject(new Error(`No upgrade: ${response.statusCode}`)));
      request.on('error', reject);
      request.end();
    });

    const forwarded = JSON.parse(received) as Record<string, string>;
    expect(forwarded['upgrade']).toBe('websocket');
    expect(forwarded['authorization']).toBeUndefined();
    expect(forwarded['x-ai-sdk-sandbox-protocol']).toBe('1');
  });

  it('is suspended to its snapshot and resumed with its files', async () => {
    await session.writeTextFile({ path: 'work.txt', content: 'kept' });

    await session.stop();
    const resumed = await resumeCloudRunNetworkSandboxSession({
      ...options,
      sandboxId: session.id,
    });

    expect(await resumed.readTextFile({ path: 'work.txt' })).toBe('kept');
  });
});
