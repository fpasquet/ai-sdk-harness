import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentClient } from './agent-client.js';

describe('the client of a machine agent', () => {
  let server: Server;
  let port: number;
  let answer: (response: ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((_, response) => answer(response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );

  const client = (): AgentClient => new AgentClient({ host: '127.0.0.1', port, token: 't' });

  it('has no protocol until the agent answers its health', async () => {
    answer = (response) => response.writeHead(503).end();
    await expect(client().health()).resolves.toBeUndefined();

    answer = (response) => response.writeHead(200).end('{"protocol":1}');
    await expect(client().health()).resolves.toBe(1);
  });

  it('reports the error of the agent, its JSON or as it came', async () => {
    answer = (response) => response.writeHead(404).end('{"error":"No process \\"p\\"."}');
    await expect(client().kill('p')).rejects.toMatchObject({
      status: 404,
      message: 'No process "p".',
    });

    answer = (response) => response.writeHead(500).end(' crashed ');
    await expect(client().killAll()).rejects.toMatchObject({ status: 500, message: 'crashed' });
  });

  it('says when the machine does not answer', async () => {
    await new Promise((resolve) => server.close(resolve));

    await expect(client().health()).resolves.toBeUndefined();
    await expect(client().wait('p')).rejects.toMatchObject({ status: 502 });
    const call = client().exec();
    call.request.end();
    await expect(call.response).rejects.toThrow("The sandbox's machine did not answer");
  });
});
