import type { AddressInfo } from 'node:net';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CloudRunSandboxServiceError } from '../errors/cloud-run-sandbox-service-error.js';
import { IdentityToken } from './identity-token.js';
import { SandboxServiceClient } from './sandbox-service-client.js';

describe('SandboxServiceClient', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let answer: { body: string; status: number };
  let authorization: string | undefined;

  beforeEach(async () => {
    server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(answer.status).end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('sends the identity token with every call', async () => {
    answer = { status: 204, body: '' };
    const client = new SandboxServiceClient(`${url}/`, {
      token: new IdentityToken(() => 'secret'),
    });

    await client.suspend('box');

    expect(authorization).toBe('Bearer secret');
  });

  it('turns a refusal of IAM into an authentication error', async () => {
    answer = { status: 403, body: 'Forbidden' };
    const client = new SandboxServiceClient(url);

    await expect(client.suspend('box')).rejects.toBeInstanceOf(HarnessSandboxAuthenticationError);
  });

  it('reports the service error, or the text of a page that is not the service', async () => {
    const client = new SandboxServiceClient(url);
    answer = { status: 409, body: JSON.stringify({ error: 'Taken.' }) };
    await expect(client.remove('box')).rejects.toThrow(
      'DELETE /v1/sandboxes/box failed with 409: Taken.',
    );

    answer = { status: 502, body: '<html>Bad gateway</html>' };
    const error = await client.remove('box').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudRunSandboxServiceError);
    expect(error).toMatchObject({ status: 502, request: 'DELETE /v1/sandboxes/box' });
  });

  it('reaches a port over a secure WebSocket, with a token read at each connection', async () => {
    let token = 'first';
    const identity = new IdentityToken(() => token);
    await identity.get();
    const client = new SandboxServiceClient('https://service.run.app', { token: identity });

    const endpoint = client.portEndpoint('box', 4000, 'ws');

    expect(endpoint.url).toBe('wss://service.run.app/v1/sandboxes/box/ports/4000');
    expect(endpoint.headers?.['Authorization']).toBe('Bearer first');
    token = 'second';
    expect(client.portEndpoint('box', 4000, 'https').url).toBe(
      'https://service.run.app/v1/sandboxes/box/ports/4000',
    );
  });
});
