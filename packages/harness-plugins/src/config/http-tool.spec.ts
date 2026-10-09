import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { resolvePlugins } from './resolve-plugins.js';

/** What the local server received of each request. */
const received: {
  method?: string;
  url?: string;
  headers: Record<string, unknown>;
  body: string;
}[] = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => (body += chunk.toString()));
  request.on('end', () => {
    received.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url?.startsWith('/slow')) return; // Never answers.
    if (request.url?.startsWith('/text')) {
      response.setHeader('content-type', 'text/plain');
      response.end('x'.repeat(25_000));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url?.startsWith('/missing') ? 404 : 200;
    response.end(request.url?.startsWith('/broken') ? '{ not json' : JSON.stringify({ ok: true }));
  });
});
let origin = '';

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Runs the http tool `definition`, its secrets resolved, with `input`. */
async function call(definition: Record<string, unknown>, input: Record<string, unknown>) {
  const { plugins } = await resolvePlugins(
    [
      {
        name: 'api',
        description: '',
        tools: { call: { type: 'http', description: 'Call', ...definition } },
      },
    ],
    { resolveSecret: (name) => `token-of-${name}` },
  );
  const execute = (plugins[0]?.tools?.call as undefined | { execute?: unknown })?.execute as (
    input: unknown,
    options: object,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: '1', messages: [] });
}

describe('an http tool', () => {
  it('fills the path from the input, the rest in the query string of a GET, its headers resolved', async () => {
    const result = await call(
      {
        url: `${origin}/packages/{name}/latest`,
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, tag: { type: 'string' } },
          required: ['name'],
        },
        headers: { Authorization: { secret: 'NPM' }, 'X-Team': 'a' },
      },
      { name: '@ai-sdk/harness', tag: 'next' },
    );
    expect(result).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(received.at(-1)).toMatchObject({
      method: 'GET',
      url: '/packages/%40ai-sdk%2Fharness/latest?tag=next',
      headers: { authorization: 'token-of-NPM', 'x-team': 'a', accept: 'application/json' },
      body: '',
    });
  });

  it('sends the rest of the input as a JSON body for a POST', async () => {
    await call(
      {
        method: 'POST',
        url: `${origin}/issues/{repo}`,
        inputSchema: z.object({ repo: z.string(), title: z.string(), labels: z.array(z.string()) }),
      },
      { repo: 'a b', title: 'Hi', labels: ['bug'] },
    );
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      url: '/issues/a%20b',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"Hi","labels":["bug"]}',
    });
  });

  it('hands over an error status, a body that is not JSON, and a long one cut', async () => {
    expect(await call({ url: `${origin}/missing` }, {})).toEqual({
      ok: false,
      status: 404,
      body: { ok: true },
    });
    expect(await call({ url: `${origin}/broken` }, {})).toEqual({
      ok: true,
      status: 200,
      body: '{ not json',
    });
    const long = (await call({ url: `${origin}/text` }, {})) as { body: string };
    expect(long.body).toMatch(/^x{20000}\n\[… 5000 more characters cut\]$/);
  });

  it('gives up after its timeout', async () => {
    expect(await call({ url: `${origin}/slow`, timeoutSeconds: 1 }, {})).toEqual({
      error: 'No answer after 1 s.',
    });
  });
});
