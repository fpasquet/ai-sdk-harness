import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Sandboxes } from '../sandboxes/sandboxes.js';
import type { HttpError } from './http-error.js';

import { SERVICE_TOKEN_HEADER } from '../../protocol/version.js';

const PORT = /^\/v1\/sandboxes\/([^/]+)\/ports\/(\d+)(\/[^?]*)?(\?.*)?$/;

/**
 * Headers that stay on this side of the tunnel: the caller's credentials, which Cloud Run's IAM
 * checked, and what Cloud Run adds on the way in. None of them enters the sandbox.
 */
const STRIPPED = new Set([
  'authorization',
  'forwarded',
  'host',
  SERVICE_TOKEN_HEADER,
  'traceparent',
  'x-cloud-trace-context',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-serverless-authorization',
]);

/** The sandbox and port a tunnel request names, with the path and query it passes on. */
function parse(url: string): undefined | { name: string; path: string; port: number } {
  const [, name, port, path = '/', query = ''] = PORT.exec(url) ?? [];
  const number = Number(port);
  if (name === undefined || !Number.isInteger(number) || number < 1 || number > 65_535) {
    return undefined;
  }
  return { name, port: number, path: `${path}${query}` };
}

/** The request as it goes on to the port: the same, without the headers of this side. */
function head(request: IncomingMessage, { port, path }: { path: string; port: number }): string {
  const lines = [`${request.method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const header = request.rawHeaders[i] ?? '';
    if (!STRIPPED.has(header.toLowerCase())) lines.push(`${header}: ${request.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * `GET /v1/sandboxes/:name/ports/:port/…` with `Upgrade`: a WebSocket, or any upgrade, to
 * `127.0.0.1:<port>` in the sandbox, where a harness bridge listens. The request is passed on as
 * it came, without the caller's credentials, through the sandbox's `connect` program.
 */
export function tunnel(
  sandboxes: Sandboxes,
  request: IncomingMessage,
  upgrade: { head: Buffer; refused?: HttpError; socket: Duplex },
): void {
  const { socket, refused } = upgrade;
  socket.on('error', () => socket.destroy());
  if (refused !== undefined) {
    socket.end(
      `HTTP/1.1 ${refused.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    return;
  }
  const target = parse(request.url ?? '');
  let child;
  try {
    if (target === undefined) throw new Error('Not a port of a sandbox.');
    child = sandboxes.get(target.name).connect(target.port);
  } catch {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  child.stdin.write(head(request, target));
  child.stdin.write(upgrade.head);
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.resume();
  void child.exited.then(() => socket.destroy());
  socket.once('close', () => child.kill());
}
