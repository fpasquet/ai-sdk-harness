import type { Socket } from 'node:net';

import type { ProxyUsage } from '../protocol/proxy.js';

/**
 * The bytes the connections of one sandbox carried through the proxy, since it was registered:
 * those of each connection added once it closes, those still open read as they stand. In memory
 * alone, as everything of the proxy: lost when it restarts, or forgets the sandbox.
 */
export class EgressMeter {
  private readonly since = new Date().toISOString();
  private readonly open = new Set<Socket>();
  private bytesRead = 0;
  private bytesWritten = 0;
  private connections = 0;

  /** Counts the connection `socket` of the sandbox, until it closes. */
  count(socket: Socket): void {
    this.connections += 1;
    this.open.add(socket);
    socket.once('close', () => {
      this.open.delete(socket);
      this.bytesRead += socket.bytesRead;
      this.bytesWritten += socket.bytesWritten;
    });
  }

  /** What the sandbox's connections carried so far, those still open included. */
  usage(): ProxyUsage {
    let { bytesRead, bytesWritten } = this;
    for (const socket of this.open) {
      bytesRead += socket.bytesRead;
      bytesWritten += socket.bytesWritten;
    }
    return {
      bytesRead,
      bytesWritten,
      connections: this.connections,
      openConnections: this.open.size,
      since: this.since,
    };
  }
}
