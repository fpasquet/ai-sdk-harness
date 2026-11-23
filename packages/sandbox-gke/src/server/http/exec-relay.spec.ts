import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Sandboxes } from '../sandboxes/sandboxes.js';

import { AgentClient } from '../sandboxes/agent-client.js';
import { execRelay } from './exec-relay.js';

/** A server on a free port of the loopback, closed by `close`. */
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe('the relay of a command to the agent of its pod', () => {
  let agent: { server: Server; port: number };
  let relay: { server: Server; port: number };
  let answer: (request: IncomingMessage, response: ServerResponse) => void;
  let failure: unknown;
  const assertNoSecret = vi.fn<Sandboxes['assertNoSecret']>();

  beforeEach(async () => {
    failure = undefined;
    assertNoSecret.mockReset().mockResolvedValue(undefined);
    agent = await listen((request, response) => answer(request, response));
    const sandboxes = {
      agent: () =>
        Promise.resolve(new AgentClient({ host: '127.0.0.1', port: agent.port, token: 't' })),
      assertNoSecret,
    } as unknown as Sandboxes;
    relay = await listen((request, response) => {
      execRelay(sandboxes, 'box', { request, response }).catch((error: unknown) => {
        failure = error;
        response.writeHead(500).end();
      });
    });
  });
  afterEach(async () => {
    await close(relay.server);
    await close(agent.server);
  });

  const exec = (body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${relay.port}/`, { method: 'POST', body });

  it('passes on the command and its input, and streams the agent’s frames back', async () => {
    let received = '';
    answer = (request, response) => {
      void bodyOf(request).then((body) => {
        received = body;
        response.writeHead(200, { 'x-process-id': 'p1' }).end('frames');
      });
    };

    const response = await exec('{"command":"cat","env":{"A":"1"}}\ninput');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-process-id')).toBe('p1');
    expect(await response.text()).toBe('frames');
    expect(received).toBe('{"command":"cat","env":{"A":"1"}}\ninput');
    expect(assertNoSecret).toHaveBeenCalledWith('box', ['cat', '', '1']);
  });

  it('reports the agent’s error, its JSON or as it came', async () => {
    answer = (_, response) => response.writeHead(409).end('{"error":"Busy."}');
    await exec('{"command":"true"}\n');
    expect(failure).toMatchObject({ status: 409, message: 'Busy.' });

    answer = (_, response) => response.writeHead(503).end('down');
    await exec('{"command":"true"}\n');
    expect(failure).toMatchObject({ status: 503, message: 'down' });

    answer = (_, response) => response.writeHead(500).end('{}');
    await exec('{"command":"true"}\n');
    expect(failure).toMatchObject({ status: 500, message: '{}' });
  });
});
