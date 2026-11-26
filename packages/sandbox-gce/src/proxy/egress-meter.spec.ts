import type { AddressInfo } from 'node:net';

import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EgressMeter } from './egress-meter.js';

describe('the egress meter of a sandbox', () => {
  let server: ReturnType<typeof createServer>;
  let accepted: Promise<Socket>;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    accepted = once(server, 'connection').then(([socket]) => socket as Socket);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('counts the bytes of an open connection as they stand, and of a closed one once', async () => {
    const meter = new EgressMeter();
    const client = connect(port, '127.0.0.1');
    const socket = await accepted;
    meter.count(socket);

    client.write('hello');
    await once(socket, 'data');
    socket.write('a longer answer');
    await once(client, 'data');
    expect(meter.usage()).toMatchObject({
      bytesRead: 5,
      bytesWritten: 15,
      connections: 1,
      openConnections: 1,
    });

    client.end();
    await once(socket, 'end');
    socket.end();
    await once(socket, 'close');
    expect(meter.usage()).toEqual({
      bytesRead: 5,
      bytesWritten: 15,
      connections: 1,
      openConnections: 0,
      since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
    });
  });
});
