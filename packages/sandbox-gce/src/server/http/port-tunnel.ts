import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { connect } from 'node:net';

import type { HttpError } from '../../common/http-error.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';

import { AGENT_TOKEN_HEADER } from '../../protocol/agent.js';
import { SERVICE_TOKEN_HEADER } from '../../protocol/version.js';

const PORT = /^\/v1\/sandboxes\/([^/]+)\/ports\/(\d+)(\/[^?]*)?(\?.*)?$/;

/**
 * Headers that stay on this side of the tunnel: the caller's credentials, which Cloud Run's IAM
 * checked, and what Cloud Run adds on the way in. None of them enters the sandbox.
 */
const STRIPPED = new Set([
  AGENT_TOKEN_HEADER,
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

const status = (code: number, text: string): string =>
  `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;

/**
 * `GET /v1/sandboxes/:name/ports/:port/…` with `Upgrade`: a WebSocket, or any upgrade, to
 * `127.0.0.1:<port>` in the sandbox's machine, where a harness bridge listens. The request is
 * passed on to the machine's agent without the caller's credentials, the agent's token in their
 * place; the agent passes it on to the port.
 */
export async function tunnel(
  sandboxes: Sandboxes,
  request: IncomingMessage,
  upgrade: { head: Buffer; refused?: HttpError; socket: Duplex },
): Promise<void> {
  const { socket, refused } = upgrade;
  socket.on('error', () => socket.destroy());
  if (refused !== undefined) {
    socket.end(status(refused.status, 'Refused'));
    return;
  }
  const target = parse(request.url ?? '');
  let agent;
  try {
    if (target === undefined) throw new Error('Not a port of a sandbox.');
    agent = await sandboxes.agent(target.name);
  } catch {
    socket.end(status(404, 'Not Found'));
    return;
  }
  const { host, port } = agent.endpoint;
  const lines = [
    `${request.method} /v1/ports/${target.port}${target.path} HTTP/1.1`,
    `Host: ${host}:${port}`,
  ];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const header = request.rawHeaders[i] ?? '';
    if (!STRIPPED.has(header.toLowerCase())) lines.push(`${header}: ${request.rawHeaders[i + 1]}`);
  }
  lines.push(`${AGENT_TOKEN_HEADER}: ${agent.endpoint.token}`);
  let opened = false;
  const upstream = connect({ host, port }, () => {
    opened = true;
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    upstream.write(upgrade.head);
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
