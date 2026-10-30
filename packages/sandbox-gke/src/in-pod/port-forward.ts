import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { connect } from 'node:net';

import { AGENT_TOKEN_HEADER } from '../protocol/agent.js';

const PORT = /^\/v1\/ports\/(\d+)(\/[^?]*)?(\?.*)?$/;

/** Headers that stay on this side of a port's tunnel. */
const STRIPPED = new Set([AGENT_TOKEN_HEADER, 'host']);

const status = (code: number, text: string): string =>
  `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;

/** The port `/v1/ports/:port/…` names, with the path and query it passes on. */
function parse(url: string): undefined | { path: string; port: number } {
  const [, port, path = '/', query = ''] = PORT.exec(url) ?? [];
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) return undefined;
  return { port: number, path: `${path}${query}` };
}

/** The request as it goes on to the port: the same, without the agent's token. */
function headOf(request: IncomingMessage, { path, port }: { path: string; port: number }): string {
  const lines = [`${request.method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const header = request.rawHeaders[i] ?? '';
    if (!STRIPPED.has(header.toLowerCase())) lines.push(`${header}: ${request.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * `GET /v1/ports/:port/…` with `Upgrade`, its token checked: passes the request on to
 * `127.0.0.1:<port>` of the pod, where a harness bridge listens, and joins the two sockets.
 */
export function forwardPort(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = parse(request.url ?? '');
  if (target === undefined) {
    socket.end(status(404, 'Not Found'));
    return;
  }
  let opened = false;
  const upstream = connect({ host: '127.0.0.1', port: target.port }, () => {
    opened = true;
    upstream.write(headOf(request, target));
    upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => {
    if (!opened) socket.end(status(502, 'Bad Gateway'));
  });
  upstream.once('close', () => {
    if (opened) socket.destroy();
  });
  socket.once('close', () => upstream.destroy());
}
