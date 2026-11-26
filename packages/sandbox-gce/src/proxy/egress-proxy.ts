import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Server as NetServer, Socket } from 'node:net';

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, createServer as createNetServer, isIP } from 'node:net';

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

/**
 * The most connections the commands of a sandbox hold open through the proxy at once, by default:
 * its tunnels and plain HTTP requests.
 */
export const DEFAULT_MAX_CONNECTIONS = 128;

/**
 * The connections a sandbox holds beyond {@link DEFAULT_MAX_CONNECTIONS}, by default, for its base
 * URL routes alone: the runtime's way to its model provider stays open whatever the commands hold.
 */
export const DEFAULT_ROUTE_CONNECTIONS = 32;

/**
 * How long the proxy keeps an idle connection of a base URL route open: longer than the runtimes'
 * clients keep theirs, so that the client always closes first. Otherwise a request sent on it just
 * as the proxy closes it is reset. Codex's client keeps an idle connection for 90 seconds; Claude
 * Code's reused one after 34 seconds. Node's default, 5 seconds, is shorter than both.
 */
export const KEEP_ALIVE_MS = 120_000;

/**
 * The most connections the proxy holds open at once, for all its sandboxes, by default: what
 * `LimitNOFILE=65536` allows, two descriptors for each connection, with a margin for the rest.
 */
export const DEFAULT_TOTAL_CONNECTIONS = 32_256;

/** The share of the proxy's connections its commands never take: the base URL routes keep it. */
const ROUTE_SHARE = 0.1;

/** What a command refused at the proxy's limit is told, and a connection cut at it. */
const PROXY_FULL =
  'The proxy holds the most connections it may, for all its sandboxes. Try again in a moment.';

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
      socket.off('end', closed);
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
    // The server keeps a socket half open once its client ended it: no `close` would come.
    socket.once('end', closed);
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

/** The host a direct TLS connection names (SNI), or why it may not leave. */
function directHost(hello: ClientHello | undefined): { host: string } | { why: string } {
  if (hello?.kind !== 'hello') return { why: 'Only TLS reaches the proxy on 443.' };
  if (hello.serverName === undefined) {
    return { why: 'A direct TLS connection must name its host (SNI).' };
  }
  return { host: canonical(hello.serverName) };
}

const connections = (count: number): string => `${count} connection${count === 1 ? '' : 's'}`;

/** What a connection carries, from its first request on: a command's traffic, or a route. */
type ConnectionKind = 'command' | 'route';

/** The connections a sandbox's machine holds open, and whether it is at one of its limits. */
interface MachineConnections {
  /** Every connection, whatever it carries, or nothing yet. */
  open: number;
  /** Those carrying a tunnel or a plain HTTP request: the commands' traffic. */
  commands: number;
  /** The connections refused since the machine reached a limit; `undefined` when it is under. */
  refused?: number;
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
 * With the sandboxes' DNS answering the proxy's address for every name, the programs that ignore
 * `HTTPS_PROXY` (Node.js's `fetch` without `NODE_USE_ENV_PROXY`, Go, Java…) reach it directly:
 *
 * - on {@link tlsServer}, a TLS connection: the host its ClientHello names (SNI) is checked as the
 *   host of a tunnel would be, then the connection is relayed as a tunnel's, never decrypted;
 * - on {@link httpServer}, a plain HTTP request: sent on to its `Host` as through `HTTP_PROXY`.
 *
 * Anything else is refused, and so is any private address however it is named: the proxy's
 * loopback, the metadata server, the VPC. A connection from a machine no sandbox holds is refused.
 * The policy is read anew for each connection: allowing a host or adding a credential applies at
 * once. Every refusal is logged, with the sandbox and what it tried to reach.
 */
export class EgressProxy {
  readonly server: Server;
  /**
   * Direct TLS connections, from programs that ignore `HTTPS_PROXY`: listened on 443 when the
   * sandboxes' DNS answers the proxy's address. Not listened on otherwise.
   */
  readonly tlsServer: NetServer;
  /** Direct plain HTTP requests, from programs that ignore `HTTP_PROXY`: listened on 80, likewise. */
  readonly httpServer: Server;

  /** The connections each machine holds open, by its address. */
  private readonly machines = new Map<string, MachineConnections>();
  /** The connections of every machine together. */
  private readonly all: MachineConnections = { open: 0, commands: 0 };
  /** What each connection carries, once its first request said. */
  private readonly kinds = new WeakMap<Socket, ConnectionKind>();
  private readonly maxConnections: number;
  private readonly routeConnections: number;
  private readonly totalConnections: number;
  private readonly tunnelPort: number;

  /**
   * @param options.maxConnections The most connections the commands of a sandbox hold open at
   *   once, its tunnels and plain HTTP requests: one more is refused, so that no sandbox takes the
   *   sockets of the others.
   * @param options.routeConnections The connections a sandbox holds beyond `maxConnections` for
   *   its base URL routes alone, so that the runtime reaches its model provider whatever the
   *   commands hold. A machine never holds more than both together.
   * @param options.totalConnections The most connections the proxy holds open at once, for all
   *   its sandboxes: below what its file descriptors allow, so that a connection beyond it is
   *   refused with a reason rather than reset by the system. A tenth of it is kept for the base
   *   URL routes, which the commands of all sandboxes together never take.
   * @param options.tunnelPort The port a tunnel reaches on its host, whatever port its `CONNECT`
   *   names (443, the only one allowed). Tests only.
   */
  constructor(
    private readonly policyFor: (address: string | undefined) => EgressPolicy | undefined,
    private readonly logger: Logger = silentLogger,
    {
      maxConnections = DEFAULT_MAX_CONNECTIONS,
      routeConnections = DEFAULT_ROUTE_CONNECTIONS,
      totalConnections = DEFAULT_TOTAL_CONNECTIONS,
      tunnelPort = 443,
    }: {
      maxConnections?: number;
      routeConnections?: number;
      totalConnections?: number;
      tunnelPort?: number;
    } = {},
  ) {
    this.maxConnections = maxConnections;
    this.routeConnections = routeConnections;
    this.totalConnections = totalConnections;
    this.tunnelPort = tunnelPort;
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.keepAliveTimeout = KEEP_ALIVE_MS;
    // Above the keep-alive: an idle connection is closed by it, never by the wait for headers.
    this.server.headersTimeout = KEEP_ALIVE_MS + 1_000;
    this.server.on('connection', (socket: Socket) => this.count(socket));
    this.server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) =>
      this.tunnel(req, socket, head),
    );
    this.tlsServer = createNetServer((socket) => this.direct(socket));
    this.httpServer = createServer((req, res) => this.forwardDirect(req, res));
    this.httpServer.keepAliveTimeout = KEEP_ALIVE_MS;
    this.httpServer.headersTimeout = KEEP_ALIVE_MS + 1_000;
    this.httpServer.on('connection', (socket: Socket) => this.count(socket));
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
    this.httpServer.closeAllConnections();
    this.httpServer.close();
    // A server never listened answers its `close` with an error: nothing to close then.
    this.tlsServer.close(() => undefined);
  }

  /**
   * Counts the connections of a machine, and refuses one beyond the proxy's limit, or cuts one
   * beyond both the machine's limits together: what it carries is not known yet.
   */
  private count(socket: Socket, plain = true): boolean {
    const address = socket.remoteAddress ?? '';
    if (this.all.open >= this.totalConnections) {
      this.proxyAtLimit(`${connections(this.all.open)} are open, base URL routes included`);
      // A direct TLS connection cannot read an HTTP answer: it is cut.
      if (plain) {
        socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n${PROXY_FULL}\n`);
      } else socket.destroy();
      return false;
    }
    const machine = this.machines.get(address) ?? { open: 0, commands: 0 };
    if (machine.open >= this.maxConnections + this.routeConnections) {
      this.atLimit(
        address,
        machine,
        `${connections(machine.open)} are open, base URL routes included`,
      );
      socket.destroy();
      return false;
    }
    machine.open += 1;
    this.all.open += 1;
    this.machines.set(address, machine);
    this.policyFor(address)?.meter?.count(socket);
    socket.once('close', () => {
      machine.open -= 1;
      this.all.open -= 1;
      if (this.kinds.get(socket) === 'command') {
        machine.commands -= 1;
        this.all.commands -= 1;
      }
      if (machine.open === 0) this.machines.delete(address);
      this.underLimit(address, machine);
      this.proxyUnderLimit();
    });
    return true;
  }

  /**
   * Why `socket` may not carry a command's traffic, `undefined` when it may: always once it does;
   * otherwise while the machine's commands hold fewer than {@link maxConnections}, and those of
   * all machines leave the routes their share of the proxy. It is then counted as a command's.
   */
  private commandRefusal(socket: Socket): string | undefined {
    if (this.kinds.has(socket)) return undefined;
    const address = socket.remoteAddress ?? '';
    const machine = this.machines.get(address);
    if (machine === undefined) return undefined;
    if (machine.commands >= this.maxConnections) {
      this.atLimit(address, machine, `its commands hold ${connections(machine.commands)}`);
      return `The sandbox holds the most connections its commands may: ${this.maxConnections}. Close some and try again.`;
    }
    if (this.all.commands >= this.commandsOfAll()) {
      this.proxyAtLimit(`the commands of its sandboxes hold ${connections(this.all.commands)}`);
      return PROXY_FULL;
    }
    machine.commands += 1;
    this.all.commands += 1;
    this.kinds.set(socket, 'command');
    return undefined;
  }

  /** The most connections the commands of all sandboxes hold together: the routes keep the rest. */
  private commandsOfAll(): number {
    return this.totalConnections - Math.ceil(this.totalConnections * ROUTE_SHARE);
  }

  /** A connection whose first request is a base URL route: never counted as a command's. */
  private admitRoute(socket: Socket): void {
    if (!this.kinds.has(socket)) this.kinds.set(socket, 'route');
  }

  /** Refuses a connection at a limit: the first refusal logged, until the machine goes under. */
  private atLimit(address: string, machine: MachineConnections, state: string): void {
    if (machine.refused === undefined) {
      const who = this.policyFor(address)?.name ?? address;
      this.logger.warn(
        `${who} reached its limit: ${state}, the most it may. More are refused until some close: ${this.limits()}.`,
      );
    }
    machine.refused = (machine.refused ?? 0) + 1;
  }

  /**
   * Logs that a machine at a limit went back well under it, three quarters of its commands' limit:
   * one connection closed, and the next refused, would otherwise log twice each time.
   */
  private underLimit(address: string, machine: MachineConnections): void {
    if (machine.refused === undefined) return;
    if (machine.commands > (this.maxConnections * 3) / 4) return;
    if (machine.open > ((this.maxConnections + this.routeConnections) * 3) / 4) return;
    const who = this.policyFor(address)?.name ?? address;
    this.logger.info(
      `${who} is back under its limit: ${connections(machine.open)} open, ${machine.commands} of its commands; ${machine.refused} refused meanwhile.`,
    );
    machine.refused = undefined;
  }

  /** Refuses a connection at the proxy's limit: the first refusal logged, with who holds the most. */
  private proxyAtLimit(state: string): void {
    if (this.all.refused === undefined) {
      this.logger.warn(
        `The proxy reached its limit: ${state}, the most it may for all its sandboxes (${this.totalConnections}, ${this.commandsOfAll()} of them for the commands). More are refused until some close. Holding the most: ${this.busiest()}.`,
      );
    }
    this.all.refused = (this.all.refused ?? 0) + 1;
  }

  /** Logs that the proxy went back under three quarters of its limits. */
  private proxyUnderLimit(): void {
    if (this.all.refused === undefined) return;
    if (this.all.commands > (this.commandsOfAll() * 3) / 4) return;
    if (this.all.open > (this.totalConnections * 3) / 4) return;
    this.logger.info(
      `The proxy is back under its limit: ${connections(this.all.open)} open, ${this.all.commands} of commands; ${this.all.refused} refused meanwhile.`,
    );
    this.all.refused = undefined;
  }

  /** The three sandboxes holding the most connections, with how many. */
  private busiest(): string {
    return [...this.machines]
      .sort(([, a], [, b]) => b.open - a.open)
      .slice(0, 3)
      .map(([address, { open }]) => `${this.policyFor(address)?.name ?? address} (${open})`)
      .join(', ');
  }

  private limits(): string {
    return `${this.maxConnections} for the commands, and ${this.routeConnections} more for the base URL routes`;
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
    const full = this.commandRefusal(socket);
    if (full !== undefined) {
      socket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n${full}\n`);
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
   * A TLS connection a program made directly, its host's name resolved to the proxy's address: the
   * host its ClientHello names (SNI) is allowed as the host of a tunnel would be, then the
   * connection is relayed to it on 443, never decrypted. One that names no host, or is no TLS, is
   * cut: there is no HTTP to answer it with.
   */
  private direct(socket: Socket): void {
    socket.on('error', () => socket.destroy());
    if (!this.count(socket, false)) return;
    const address = socket.remoteAddress;
    const policy = this.policyFor(address);
    if (policy === undefined) {
      this.refused({ address, why: UNKNOWN });
      socket.destroy();
      return;
    }
    void clientHello(socket, Buffer.alloc(0)).then(({ bytes, hello }) => {
      if (socket.destroyed) return;
      const named = directHost(hello);
      if ('why' in named) {
        this.refused({ address, policy, why: named.why });
        socket.destroy();
        return;
      }
      const { host } = named;
      const reach = reachability(policy, host);
      const refusal = isListedHost(policy.allowedHosts, host)
        ? reach.error
        : `${host} is not reachable from the sandbox.`;
      const full = refusal ?? this.commandRefusal(socket);
      if (full !== undefined) {
        this.refused({ address, policy, target: host, why: full });
        socket.destroy();
        return;
      }
      const upstream = connect({ host, port: this.tunnelPort, lookup: reach.lookup }, () => {
        upstream.write(bytes);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
    });
  }

  /**
   * A plain HTTP request a program sent directly, its host's name resolved to the proxy's
   * address: sent on to its `Host` as a request through `HTTP_PROXY` would be.
   */
  private forwardDirect(req: IncomingMessage, res: ServerResponse): void {
    const address = req.socket.remoteAddress;
    const policy = this.policyFor(address);
    if (policy === undefined) {
      this.deny(res, { address, why: UNKNOWN });
      return;
    }
    const host = req.headers.host;
    if (host === undefined || host === '' || !(req.url ?? '').startsWith('/')) {
      this.deny(res, { address, policy, why: 'A direct HTTP request must name its host (Host).' });
      return;
    }
    this.forwardPlain(req, res, { policy, url: `http://${host}${req.url ?? '/'}` });
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
      this.forwardPlain(req, res, { policy });
      return;
    }
    const refusal = routeRefusal(policy, route);
    if (refusal !== undefined) {
      this.deny(res, { address, policy, target: route.host, why: refusal });
      return;
    }
    this.admitRoute(req.socket);
    this.send(req, res, { policy, target: route, transformations: policy.transformations });
  }

  /** A plain HTTP request through `HTTP_PROXY`: sent on to an allowed host, refused otherwise. */
  private forwardPlain(
    req: IncomingMessage,
    res: ServerResponse,
    { policy, url = req.url ?? '' }: { policy: EgressPolicy; url?: string },
  ): void {
    const plain = plainTarget(url);
    if (plain !== undefined && isListedHost(policy.allowedHosts, plain.hostname)) {
      const full = this.commandRefusal(req.socket);
      if (full !== undefined) {
        res.writeHead(503, { 'content-type': 'text/plain', connection: 'close' });
        res.end(`${full}\n`);
        return;
      }
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
