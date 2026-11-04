import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP } from 'node:net';

import type { Logger } from '../common/logger.js';
import type { EgressPolicy } from './egress-policy.js';

import { silentLogger } from '../common/logger.js';
import { routeTarget } from '../protocol/proxy-routes.js';
import {
  injectedCredentials,
  isListedHost,
  isRoutable,
  transformHeaders,
  withoutCredentials,
} from './egress-policy.js';
import { isPrivateAddress, publicOnlyLookup } from './network-guard.js';
import { type ClientHello, readClientHello } from './tls-hello.js';

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

const UNKNOWN = 'This machine is no sandbox the proxy serves.';

/** The most connections a sandbox's machine holds open through the proxy at once, by default. */
export const DEFAULT_MAX_CONNECTIONS = 128;

/** The most bytes a ClientHello is read from: well over any real one. */
const MAX_HELLO_BYTES = 64 * 1024;

/** How long a client has to send its ClientHello once its tunnel is open. */
const HELLO_TIMEOUT_MS = 10_000;

/** A name as TLS and DNS compare it: whatever its case, without its trailing dot. */
const canonical = (name: string): string => name.toLowerCase().replace(/\.$/, '');

/**
 * Reads the ClientHello a client opens its tunnel with, `head` the bytes that came with the
 * `CONNECT`: the bytes read, and the hello, unless they are no TLS or the client went quiet.
 */
function clientHello(
  socket: Socket,
  head: Buffer,
): Promise<{ bytes: Buffer; hello?: ClientHello }> {
  return new Promise((resolve) => {
    let bytes = head;
    const done = (hello?: ClientHello): void => {
      clearTimeout(timer);
      socket.off('data', received);
      socket.off('close', closed);
      socket.pause();
      resolve({ bytes, hello });
    };
    const check = (): void => {
      const hello = readClientHello(bytes);
      if (hello.kind === 'hello') done(hello);
      else if (hello.kind === 'invalid' || bytes.length > MAX_HELLO_BYTES) done();
    };
    const received = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      check();
    };
    const closed = (): void => done();
    const timer = setTimeout(done, HELLO_TIMEOUT_MS);
    socket.on('data', received);
    socket.once('close', closed);
    if (bytes.length > 0) check();
  });
}

/**
 * Why a tunnel to `host` may not carry the TLS connection `hello` opens: `undefined` when it may.
 * The server a ClientHello names is the one a shared front end, a CDN, serves: a tunnel opened to
 * an allowed host must not reach another site of the same CDN.
 */
function helloRefusal(host: string, hello: ClientHello | undefined): string | undefined {
  if (hello?.kind !== 'hello') return `Only TLS goes through a tunnel to ${host}.`;
  const named = hello.serverName === undefined ? undefined : canonical(hello.serverName);
  if (isIP(host) !== 0) {
    return named === undefined
      ? undefined
      : `A tunnel to ${host} may not name ${named} in its TLS.`;
  }
  if (named === canonical(host)) return undefined;
  return named === undefined
    ? `A tunnel to ${host} must name it in its TLS (SNI).`
    : `A tunnel to ${host} may not name ${named} in its TLS.`;
}

/** A connection or a request the proxy refused: from what machine and sandbox, to what, why. */
interface Refusal {
  address: string | undefined;
  policy?: EgressPolicy;
  target?: string;
  why: string;
}

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
 * The way out of the sandboxes, on a machine of its own, outside their security boundary: the VPC
 * firewall lets their machines reach nothing else. Every connection is the sandbox's whose machine
 * it comes from, and is one of two things:
 *
 * - a `CONNECT host:443`, through the sandbox's `HTTPS_PROXY`: tunnelled when `host` is allowed,
 *   refused otherwise. The tunnel is TLS end to end: its ClientHello is read, and the tunnel cut
 *   unless it names `host` (SNI), so that no other site behind the same CDN is reached; nothing
 *   else in it is read or changed;
 * - a plain request to a base URL route (`/https/<host>/…`, see `proxy-routes.ts`): sent on to
 *   its host, the sandbox's request transformations applied to it on the way. The real credential
 *   never enters the sandbox;
 * - a plain HTTP request through `HTTP_PROXY` to an allowed host, as package mirrors still serve:
 *   sent on as it is, no credential put in.
 *
 * Anything else is refused, and so is any private address however it is named: the proxy's
 * loopback, the metadata server, the VPC. A connection from a machine no sandbox holds is refused.
 * The policy is read anew for each connection: allowing a host or adding a credential applies at
 * once. Every refusal is logged, with the sandbox and what it tried to reach.
 */
export class EgressProxy {
  readonly server: Server;

  /** The connections each machine holds open, by its address. */
  private readonly open = new Map<string, number>();
  /** The machines cut at their limit since they last went under it: logged once. */
  private readonly capped = new Set<string>();
  private readonly maxConnections: number;
  private readonly tunnelPort: number;

  /**
   * @param options.maxConnections The most connections a sandbox's machine holds open at once:
   *   one more is cut at once, so that no sandbox takes the sockets of the others.
   * @param options.tunnelPort The port a tunnel reaches on its host, whatever port its `CONNECT`
   *   names (443, the only one allowed). Tests only.
   */
  constructor(
    private readonly policyFor: (address: string | undefined) => EgressPolicy | undefined,
    private readonly logger: Logger = silentLogger,
    {
      maxConnections = DEFAULT_MAX_CONNECTIONS,
      tunnelPort = 443,
    }: { maxConnections?: number; tunnelPort?: number } = {},
  ) {
    this.maxConnections = maxConnections;
    this.tunnelPort = tunnelPort;
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on('connection', (socket: Socket) => this.count(socket));
    this.server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) =>
      this.tunnel(req, socket, head),
    );
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  /**
   * Counts the connections of a machine, and cuts the one beyond {@link maxConnections}: logged the
   * first time only, until the machine goes under its limit again.
   */
  private count(socket: Socket): void {
    const address = socket.remoteAddress ?? '';
    const open = this.open.get(address) ?? 0;
    if (open >= this.maxConnections) {
      if (!this.capped.has(address)) {
        this.capped.add(address);
        const why = `${open} connections are open already, the most a sandbox holds at once.`;
        this.refused({ address, policy: this.policyFor(address), why });
      }
      socket.destroy();
      return;
    }
    this.open.set(address, open + 1);
    socket.once('close', () => {
      const left = (this.open.get(address) ?? 1) - 1;
      if (left === 0) this.open.delete(address);
      else this.open.set(address, left);
      this.capped.delete(address);
    });
  }

  private tunnel(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const { hostname, port } = new URL(`http://${req.url ?? ''}`);
    const address = socket.remoteAddress;
    const policy = this.policyFor(address);
    if (policy === undefined) {
      this.refused({ address, target: req.url, why: UNKNOWN });
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${UNKNOWN}\n`);
      return;
    }
    const reach = reachability(policy, hostname);
    const listed = port === '443' && isListedHost(policy.allowedHosts, hostname);
    const refusal = listed ? reach.error : `${hostname} is not reachable from the sandbox.`;
    if (refusal !== undefined) {
      this.refused({ address, policy, target: req.url, why: refusal });
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${refusal}\n`);
      return;
    }
    const upstream = connect(
      { host: hostname, port: this.tunnelPort, lookup: reach.lookup },
      () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        void clientHello(socket, head).then(({ bytes, hello }) => {
          if (socket.destroyed) return;
          const why = helloRefusal(hostname, hello);
          if (why !== undefined) {
            this.refused({ address, policy, target: req.url, why });
            socket.destroy();
            upstream.destroy();
            return;
          }
          upstream.write(bytes);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
      },
    );
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  }

  /**
   * A plain request: a base URL route, its credentials put in, or, through `HTTP_PROXY`, plain HTTP
   * to an allowed host, as package mirrors still serve, with no credential at all.
   */
  private forward(req: IncomingMessage, res: ServerResponse): void {
    const address = req.socket.remoteAddress;
    const policy = this.policyFor(address);
    if (policy === undefined) {
      this.deny(res, { address, why: UNKNOWN });
      return;
    }
    const route = targetOf(req.url ?? '');
    if (route === undefined) {
      this.forwardPlain(req, res, policy);
      return;
    }
    const refusal = routeRefusal(policy, route);
    if (refusal !== undefined) {
      this.deny(res, { address, policy, target: route.host, why: refusal });
      return;
    }
    this.send(req, res, { policy, target: route, transformations: policy.transformations });
  }

  /** A plain HTTP request through `HTTP_PROXY`: sent on to an allowed host, refused otherwise. */
  private forwardPlain(req: IncomingMessage, res: ServerResponse, policy: EgressPolicy): void {
    const plain = plainTarget(req.url ?? '');
    if (plain !== undefined && isListedHost(policy.allowedHosts, plain.hostname)) {
      this.send(req, res, { policy, target: plain, transformations: [] });
      return;
    }
    // The host alone: a path or a query string may carry what is no business of the log.
    const why = routeRefusal(policy, undefined) ?? '';
    this.deny(res, { address: req.socket.remoteAddress, policy, target: plain?.host, why });
  }

  /** Refuses a plain request, and logs it. */
  private deny(res: ServerResponse, refusal: Refusal): void {
    this.refused(refusal);
    refuse(res, refusal.why);
  }

  /**
   * Logs a refusal: what was refused to whom, the sandbox or else the machine's address, so that a
   * missing allowed host shows.
   */
  private refused({ address, policy, target, why }: Refusal): void {
    const who = policy?.name ?? address ?? 'an unknown machine';
    this.logger.info(`Refused ${target ?? '?'} to ${who}: ${why}`);
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
      this.deny(res, {
        address: req.socket.remoteAddress,
        policy,
        target: target.host,
        why: reach.error,
      });
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
