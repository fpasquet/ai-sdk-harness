import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP } from 'node:net';

import type { EgressPolicy } from './egress-policy.js';

import { routeTarget } from '../protocol/proxy-routes.js';
import {
  injectedCredentials,
  isListedHost,
  isRoutable,
  transformHeaders,
  withoutCredentials,
} from './egress-policy.js';
import { isPrivateAddress, publicOnlyLookup } from './network-guard.js';

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

const UNKNOWN = 'This pod is no sandbox the proxy serves.';

const refuse = (res: ServerResponse, message: string): void => {
  res.writeHead(403, { 'content-type': 'text/plain' }).end(`${message}\n`);
};

/** Why a request may not leave through `route`, a base URL route: `undefined` when it may. */
function routeRefusal(policy: EgressPolicy, route: undefined | URL): string | undefined {
  if (route === undefined) {
    return 'Only HTTPS through the proxy, or a base URL route, leaves the sandbox.';
  }
  if (!isRoutable(policy, route.hostname)) {
    return `${route.hostname} is not reachable from the sandbox.`;
  }
  if (route.protocol === 'http:' && !policy.allowPrivateNetwork) {
    return 'A base URL must be HTTPS: the credentials it carries never travel in clear.';
  }
  return undefined;
}

/** The URL of a plain HTTP request sent through `HTTP_PROXY`, unless it is a route. */
function plainTarget(url: string): undefined | URL {
  if (!url.startsWith('http://')) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Where a request really goes: a base URL route, given as a path or, through a proxy, a URL. */
function targetOf(url: string): undefined | URL {
  if (url.startsWith('/')) return routeTarget(url);
  try {
    // A client that ignored NO_PROXY sends the route to the proxy as a proxy request.
    const { pathname, search } = new URL(url);
    return routeTarget(`${pathname}${search}`);
  } catch {
    return undefined;
  }
}

/**
 * The way out of the sandboxes, in a pod of its own, outside their security boundary: the network
 * policy lets their pods reach nothing else. Every connection is the sandbox's whose pod it comes
 * from, and is one of three things:
 *
 * - a `CONNECT host:443`, through the sandbox's `HTTPS_PROXY`: tunnelled when `host` is allowed,
 *   refused otherwise. The tunnel is TLS end to end: nothing in it is read or changed;
 * - a plain request to a base URL route (`/https/<host>/…`, see `proxy-routes.ts`): sent on to
 *   its host, the sandbox's request transformations applied to it on the way. The real credential
 *   never enters the sandbox;
 * - a plain HTTP request through `HTTP_PROXY` to an allowed host, as package mirrors still serve:
 *   sent on as it is, no credential put in.
 *
 * Anything else is refused, and so is any private address however it is named: the proxy's
 * loopback, the metadata server, the cluster, the VPC. A connection from a pod no sandbox holds is refused.
 * The policy is read anew for each connection: allowing a host or adding a credential applies at
 * once.
 */
export class EgressProxy {
  readonly server: Server;

  constructor(
    private readonly policyFor: (address: string | undefined) => EgressPolicy | undefined,
  ) {
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) =>
      this.tunnel(req, socket, head),
    );
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  private tunnel(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const { hostname, port } = new URL(`http://${req.url ?? ''}`);
    const policy = this.policyFor(socket.remoteAddress);
    if (policy === undefined) {
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${UNKNOWN}\n`);
      return;
    }
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

  /**
   * A plain request: a base URL route, its credentials put in, or, through `HTTP_PROXY`, plain HTTP
   * to an allowed host, as package mirrors still serve, with no credential at all.
   */
  private forward(req: IncomingMessage, res: ServerResponse): void {
    const policy = this.policyFor(req.socket.remoteAddress);
    if (policy === undefined) {
      refuse(res, UNKNOWN);
      return;
    }
    const route = targetOf(req.url ?? '');
    const plain = route === undefined ? plainTarget(req.url ?? '') : undefined;
    if (plain !== undefined && isListedHost(policy.allowedHosts, plain.hostname)) {
      this.send(req, res, { policy, target: plain, transformations: [] });
      return;
    }
    const refusal = routeRefusal(policy, route);
    if (refusal !== undefined || route === undefined) {
      refuse(res, refusal ?? '');
      return;
    }
    this.send(req, res, { policy, target: route, transformations: policy.transformations });
  }

  /** Sends `req` on to `target`, `transformations` applied, and its answer back without them. */
  private send(
    req: IncomingMessage,
    res: ServerResponse,
    {
      policy,
      target,
      transformations,
    }: {
      policy: EgressPolicy;
      target: URL;
      transformations: EgressPolicy['transformations'];
    },
  ): void {
    const reach = reachability(policy, target.hostname);
    if (reach.error !== undefined) {
      refuse(res, reach.error);
      return;
    }
    const path = `${target.pathname}${target.search}`;
    const outgoing = {
      host: target.hostname,
      method: req.method ?? 'GET',
      path,
      headers: forwardable(req.headers),
    };
    const headers = transformHeaders(transformations, outgoing);
    const credentials = injectedCredentials(transformations, outgoing);
    const request = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path,
        headers,
        lookup: reach.lookup,
      },
      (response) => {
        const answered = withoutCredentials(forwardable(response.headers), credentials);
        res.writeHead(response.statusCode ?? 502, answered);
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
