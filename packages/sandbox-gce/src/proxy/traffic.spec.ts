import type { Socket } from 'node:net';

import { connect, createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { formatBytes, Traffic } from './traffic.js';

describe('the traffic of a sandbox', () => {
  it('counts its connections as they go, and once they closed', async () => {
    const traffic = new Traffic();
    const accepted = Promise.withResolvers<Socket>();
    const server = createServer((socket) => {
      traffic.track(socket);
      // Read, as the proxy reads every connection: unread, it would never see its end.
      socket.resume();
      accepted.resolve(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const client = connect({ host: '127.0.0.1', port });

    client.write('hello');
    const socket = await accepted.promise;
    socket.write('hey');
    await vi.waitFor(() => expect(traffic.totals).toEqual({ sent: 5, received: 3 }));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    client.destroy();
    await closed;
    server.close();

    expect(traffic.totals).toEqual({ sent: 5, received: 3 });
  });

  it('reads as bytes, then in thousands', () => {
    expect([0, 999, 1000, 12_345_678, 4.2e9, 7e15].map(formatBytes)).toEqual([
      '0 B',
      '999 B',
      '1.0 kB',
      '12.3 MB',
      '4.2 GB',
      '7000.0 TB',
    ]);
  });
});
