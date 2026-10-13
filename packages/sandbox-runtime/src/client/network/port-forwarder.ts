import type { AddressInfo, Server, Socket } from 'node:net';

import { createServer } from 'node:net';

import type { LinkChannel } from '../transport/supervisor-link.js';

/** A port of the sandbox, reachable on this host's loopback. */
export interface ForwardedPort {
  /** `http://127.0.0.1:<port on this host>`. */
  readonly url: string;
  /** Stops listening and cuts the connections still open. */
  close(): Promise<void>;
}

/** Joins `socket` to `channel`, a connection to a port of the sandbox, both ways. */
function join(socket: Socket, channel: LinkChannel): void {
  channel.onData = (chunk) => socket.write(chunk);
  channel.onEnd = () => socket.end();
  void channel.closed.then(() => socket.destroy());
  socket.on('data', (chunk: Buffer) => channel.write(chunk));
  socket.on('end', () => channel.end());
  socket.once('close', () => channel.kill());
}

/**
 * Listens on a free port of this host's loopback, each connection going on to `port` in the
 * sandbox through a channel `connect` opens. The sandbox has a network of its own: its loopback is
 * reached through its supervisor, never directly.
 */
export async function forwardPort(
  port: number,
  connect: (port: number) => Promise<LinkChannel>,
): Promise<ForwardedPort> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.pause();
    connect(port).then(
      (channel) => {
        join(socket, channel);
        socket.resume();
      },
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port: local } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${local}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
