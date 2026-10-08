import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP } from 'node:net';

import type { EgressPolicy } from './egress-policy.js';

import { isListedHost, isRoutable, transformHeaders } from './egress-policy.js';
import { isPrivateAddress, publicOnlyLookup } from './network-guard.js';
import { routeTarget } from './relay-routes.js';

/** Headers of one hop only: never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const forwardable = (headers: IncomingHttpHeaders): IncomingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));

/**
 * How the proxy reaches `host`: anywhere when the policy allows private networks, otherwise only
 * public addresses: `host` an IP address of the public internet, or a name resolving to one.
 */
function reachability(
  policy: EgressPolicy,
  host: string,
): { error?: string; lookup?: typeof publicOnlyLookup } {
  if (policy.allowPrivateNetwork) return {};
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    return { error: `${host} is a private address, out of reach of the sandbox.` };
  }
  return { lookup: publicOnlyLookup };
}

const refuse = (res: ServerResponse, message: string): void => {
  res.writeHead(403, { 'content-type': 'text/plain' }).end(`${message}\n`);
};

/**
 * The way out of one sandbox, in the service, outside the sandbox's security boundary. Every
 * connection the sandbox's egress relay carries ends up here, and is one of two things:
 *
 * - a `CONNECT host:443`, through the sandbox's `HTTPS_PROXY`: tunnelled when `host` is allowed,
 *   refused otherwise. The tunnel is TLS end to end: nothing in it is read or changed;
 * - a plain request to a base URL route (`/https/<host>/…`, see `relay-routes.ts`): sent on to
 *   its host, the policy's request transformations applied to it on the way. The real credential
 *   never enters the sandbox.
 *
 * Anything else is refused, and so is any private address however it is named: the service's
 * loopback, the metadata server, the VPC. The policy is read anew for each connection: allowing a
 * host or adding a credential applies at once.
 */
export class EgressProxy {
  private listening?: Promise<number>;
  private readonly server: Server;

  constructor(private readonly policy: () => EgressPolicy) {
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) =>
      this.tunnel(req, socket, head),
    );
  }

  /** The loopback port the proxy listens on, started the first time. */
  port(): Promise<number> {
    this.listening ??= new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () =>
        resolve((this.server.address() as AddressInfo).port),
      );
    });
    return this.listening;
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  private tunnel(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const { hostname, port } = new URL(`http://${req.url ?? ''}`);
    const policy = this.policy();
    const reach = reachability(policy, hostname);
    const listed = port === '443' && isListedHost(policy.allowedHosts, hostname);
    const refusal = listed ? reach.error : `${hostname} is not reachable from the sandbox.`;
    if (refusal !== undefined) {
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${refusal}\n`);
      return;
    }
    const upstream = connect({ host: hostname, port: 443, lookup: reach.lookup }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const target = routeTarget(req.url ?? '');
    if (target === undefined) {
      refuse(res, 'Only HTTPS through the proxy, or a base URL route, leaves the sandbox.');
      return;
    }
    const policy = this.policy();
    if (!isRoutable(policy, target.hostname)) {
      refuse(res, `${target.hostname} is not reachable from the sandbox.`);
      return;
    }
    if (target.protocol === 'http:' && !policy.allowPrivateNetwork) {
      refuse(res, 'A base URL must be HTTPS: the credentials it carries never travel in clear.');
      return;
    }
    const reach = reachability(policy, target.hostname);
    if (reach.error !== undefined) {
      refuse(res, reach.error);
      return;
    }
    const path = `${target.pathname}${target.search}`;
    const headers = transformHeaders(policy.transformations, {
      host: target.hostname,
      method: req.method ?? 'GET',
      path,
      headers: forwardable(req.headers),
    });
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const upstream = send(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path,
        headers,
        lookup: reach.lookup,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, forwardable(response.headers));
        response.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`${error.message}\n`);
    });
    req.pipe(upstream);
  }
}
