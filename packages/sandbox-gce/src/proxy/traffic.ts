import type { Socket } from 'node:net';

const UNITS = ['kB', 'MB', 'GB', 'TB'];

/** `bytes` for a log line: `512 B`, `12.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  for (value /= 1000; value >= 1000 && unit < UNITS.length - 1; value /= 1000) unit++;
  return `${value.toFixed(1)} ${UNITS[unit] ?? ''}`;
}

/**
 * The bytes one sandbox moved through the proxy, over every connection of its machine: those
 * closed, and those still open as they stand. A tunnel's TLS and a request's headers included.
 */
export class Traffic {
  private closedSent = 0;
  private closedReceived = 0;
  private readonly open = new Set<Socket>();

  /** Counts the connection `socket` of the sandbox's machine, from now on. */
  track(socket: Socket): void {
    this.open.add(socket);
    socket.once('close', () => {
      this.open.delete(socket);
      this.closedSent += socket.bytesRead;
      this.closedReceived += socket.bytesWritten;
    });
  }

  /** `sent`: what left the sandbox; `received`: what came back into it. */
  get totals(): { received: number; sent: number } {
    let sent = this.closedSent;
    let received = this.closedReceived;
    for (const socket of this.open) {
      sent += socket.bytesRead;
      received += socket.bytesWritten;
    }
    return { sent, received };
  }
}
