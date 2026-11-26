import type { AddressInfo } from 'node:net';

import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GceSandboxCapacityError } from '../errors/gce-sandbox-capacity-error.js';
import { GceSandboxServiceError } from '../errors/gce-sandbox-service-error.js';
import { IdentityToken } from './identity-token.js';
import { SandboxServiceClient } from './sandbox-service-client.js';

describe('SandboxServiceClient', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let answer: { body: string; headers?: Record<string, string>; status: number };
  /** Answers to give before `answer`, one per request. */
  let firstAnswers: { body: string; headers?: Record<string, string>; status: number }[];
  let requests: string[];
  /** The bodies of the requests, as text. */
  let bodies: string[];
  let authorization: string | undefined;

  beforeEach(async () => {
    firstAnswers = [];
    requests = [];
    bodies = [];
    server = createServer((request, response) => {
      authorization = request.headers.authorization;
      requests.push(`${request.method} ${request.url}`);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString());
        const { status, body, headers = {} } = firstAnswers.shift() ?? answer;
        response.writeHead(status, headers).end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('refuses a service in plain HTTP, but on the loopback', () => {
    expect(() => new SandboxServiceClient('http://sandboxes.internal:8080')).toThrow(
      "The sandbox service's URL must be HTTPS, but on the loopback: http://sandboxes.internal:8080 would carry the identity token and the service token in clear.",
    );
    for (const local of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
      expect(() => new SandboxServiceClient(local), local).not.toThrow();
    }
    expect(() => new SandboxServiceClient('https://sandboxes-abc.a.run.app')).not.toThrow();
  });

  it('sends the identity token with every call', async () => {
    answer = { status: 204, body: '' };
    const client = new SandboxServiceClient(`${url}/`, {
      token: new IdentityToken(() => 'secret'),
    });

    await client.suspend('box');

    expect(authorization).toBe('Bearer secret');
  });

  it('prepares the service, one of an earlier version without the route included', async () => {
    const client = new SandboxServiceClient(url);
    answer = { status: 204, body: '' };
    await client.prepare();

    answer = { status: 404, body: JSON.stringify({ error: 'Not found.' }) };
    await expect(
      client.prepare({ template: 'ai-sdk-harness-template-abc', image: 'python' }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual(['POST /v1/prepare', 'POST /v1/prepare']);
    expect(bodies.map((body) => JSON.parse(body) as unknown)).toEqual([
      {},
      { template: 'ai-sdk-harness-template-abc', image: 'python' },
    ]);
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

  it('tells a refusal for the most sandboxes running apart, as a service error still', async () => {
    const client = new SandboxServiceClient(url);
    const refusal = {
      error: '2 sandboxes run already.',
      code: 'SANDBOX_MAX_RUNNING',
      running: 2,
      max: 2,
      retryAfterSeconds: 30,
    };
    answer = { status: 429, body: JSON.stringify(refusal), headers: { 'retry-after': '30' } };

    const error = await client.create('box', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GceSandboxCapacityError);
    expect(error).toBeInstanceOf(GceSandboxServiceError);
    expect(error).toMatchObject({
      name: 'GceSandboxCapacityError',
      status: 429,
      request: 'POST /v1/sandboxes',
      running: 2,
      max: 2,
      retryAfterSeconds: 30,
      message: 'POST /v1/sandboxes failed with 429: 2 sandboxes run already.',
    });

    // The header alone, from a body that leaves it out; any other 429 stays a service error.
    answer = {
      status: 429,
      body: JSON.stringify({ ...refusal, retryAfterSeconds: undefined }),
      headers: { 'retry-after': '12' },
    };
    await expect(client.resume('box', {})).rejects.toMatchObject({ retryAfterSeconds: 12 });
    answer = { status: 429, body: 'Rate exceeded.' };
    const other = await client.create('box', {}).catch((caught: unknown) => caught);
    expect(other).not.toBeInstanceOf(GceSandboxCapacityError);
    expect(other).toMatchObject({ status: 429 });
  });

  it('waits for a template whose save was cut on the way, and reports a refusal at once', async () => {
    const client = new SandboxServiceClient(url);
    firstAnswers = [
      { status: 504, body: 'upstream request timeout' },
      { status: 404, body: JSON.stringify({ error: 'No template.' }) },
    ];
    answer = { status: 200, body: JSON.stringify({ id: 't1' }) };

    await client.saveTemplate('builder', 't1', { image: 'python' });
    expect(requests).toEqual([
      'POST /v1/sandboxes/builder/template',
      'GET /v1/templates/t1?image=python',
      'GET /v1/templates/t1?image=python',
    ]);

    requests = [];
    firstAnswers = [{ status: 500, body: JSON.stringify({ error: 'Disk gone.' }) }];
    await expect(client.saveTemplate('builder', 't2')).rejects.toThrow('500: Disk gone.');
    expect(requests).toHaveLength(1);
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
