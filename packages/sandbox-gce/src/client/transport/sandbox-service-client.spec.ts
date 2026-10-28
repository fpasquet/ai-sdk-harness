import type { AddressInfo } from 'node:net';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GceSandboxServiceError } from '../errors/gce-sandbox-service-error.js';
import { IdentityToken } from './identity-token.js';
import { SandboxServiceClient } from './sandbox-service-client.js';

describe('SandboxServiceClient', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let answer: { body: string; status: number };
  /** Answers to give before `answer`, one per request. */
  let firstAnswers: { body: string; status: number }[];
  let requests: string[];
  let authorization: string | undefined;

  beforeEach(async () => {
    firstAnswers = [];
    requests = [];
    server = createServer((request, response) => {
      authorization = request.headers.authorization;
      requests.push(`${request.method} ${request.url}`);
      const { status, body } = firstAnswers.shift() ?? answer;
      response.writeHead(status).end(body);
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
    expect(error).toBeInstanceOf(GceSandboxServiceError);
    expect(error).toMatchObject({ status: 502, request: 'DELETE /v1/sandboxes/box' });
  });

  it('sends the input of a process again after a passing error, never after a refusal', async () => {
    const client = new SandboxServiceClient(url);
    firstAnswers = [
      { status: 503, body: 'Service Unavailable' },
      { status: 502, body: 'Bad gateway' },
    ];
    answer = { status: 204, body: '' };

    await client.writeInput('box', 'p1', { offset: 4, bytes: new Uint8Array(1) });
    expect(requests).toEqual(Array(3).fill('POST /v1/sandboxes/box/processes/p1/stdin?offset=4'));

    requests = [];
    answer = { status: 409, body: JSON.stringify({ error: 'Closed.' }) };
    await expect(client.endInput('box', 'p1')).rejects.toThrow('409: Closed.');
    expect(requests).toHaveLength(1);
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
