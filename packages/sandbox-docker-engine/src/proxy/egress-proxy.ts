// The egress proxy of a sandbox, run alone in a container of its own: the only bridge between the
// sandbox's internal network and the outside. Node.js runs this file as it is, in any image that
// has Node.js 24: it imports nothing but Node.js, and its TypeScript is only type annotations.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket, Server as TcpServer } from 'node:net';

import { lookup } from 'node:dns/promises';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { BlockList, connect, createServer as createTcpServer, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

/** The policy the proxy reads, from a file, at each connection. */
export interface EgressPolicy {
  mode: 'allow-all' | 'custom' | 'deny-all';
  /** A host name, or `*.<domain>` for its subdomains. */
  allowedHosts?: readonly string[];
}

/** A port of the sandbox the proxy forwards from its own `listen` port. */
export interface PortForward {
  listen: number;
  host: string;
  port: number;
}

export interface EgressProxyOptions {
  /** The JSON file of the {@link EgressPolicy}: missing or unreadable, everything is refused. */
  policyFile: string;
  /** Where each refused request is appended, one JSON line. */
  logFile: string;
  /** The port the proxy listens on. */
  port: number;
  /** The address it listens on. Default: every address. */
  host?: string;
  forwards?: readonly PortForward[];
  /** Resolves a host name. Default: the system's resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Whether an address is one never to connect to. Default: {@link isPrivateAddress}. */
  isPrivate?: (address: string) => boolean;
}

/** Why a request was refused. */
export type RefusalReason = 'policy' | 'private-address' | 'unresolved';

/**
 * Addresses a sandbox never reaches through the proxy, whatever its policy: this host and its
 * networks, link-local ones and the cloud metadata service among them.
 */
const PRIVATE_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE_V4.addSubnet(network, prefix, 'ipv4');
}
// A list of its own: a rule on IPv4 addresses in IPv6 (`::ffff:0:0/96`) matches every IPv4 one.
const PRIVATE_V6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4 addresses written in IPv6, mapped or NAT64, in their hexadecimal form: refused whole.
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE_V6.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address`, an IP address, is one the proxy never connects to. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.check(address, 'ipv4');
  if (family !== 6) return true;
  // An IPv6 address carrying an IPv4 one in its dotted form: mapped (::ffff:a.b.c.d) or NAT64.
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (embedded !== undefined) return PRIVATE_V4.check(embedded, 'ipv4');
  return PRIVATE_V6.check(address, 'ipv6');
}

/** Whether `host` matches an entry of `hosts`: a name as listed, or a subdomain of `*.<domain>`. */
export function matchesHost(hosts: readonly string[], host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (name === '' || name.startsWith('.')) return false;
  return hosts.some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/\.$/, '');
    return rule.startsWith('*.') ? name.endsWith(rule.slice(1)) : name === rule;
  });
}

/** The policy in `file`, read now; anything unreadable refuses everything. */
export function readPolicy(file: string): EgressPolicy {
  try {
    const policy = JSON.parse(readFileSync(file, 'utf8')) as Partial<EgressPolicy>;
    if (policy.mode === 'allow-all' || policy.mode === 'deny-all') return { mode: policy.mode };
    if (policy.mode === 'custom' && Array.isArray(policy.allowedHosts)) {
      return {
        mode: 'custom',
        allowedHosts: policy.allowedHosts.filter((host) => typeof host === 'string'),
      };
    }
  } catch {
    // Missing or unreadable: refused below.
  }
  return { mode: 'deny-all' };
}

/** Whether the policy in `file` lets the sandbox reach `host`. */
export function allows(file: string, host: string): boolean {
  const policy = readPolicy(file);
  if (policy.mode === 'allow-all') return true;
  if (policy.mode === 'deny-all') return false;
  return matchesHost(policy.allowedHosts ?? [], host);
}

const systemResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);

/** The headers of a request to send on: the proxy's own ones left out, `Host` the target's. */
function withoutProxyHeaders(
  headers: IncomingMessage['headers'],
  host: string,
): IncomingMessage['headers'] {
  const {
    'proxy-authorization': _authorization,
    'proxy-connection': _connection,
    ...kept
  } = headers;
  return { ...kept, host };
}

/** `host:port` of a `CONNECT` request, its brackets taken off an IPv6 address. */
function splitTarget(target: string): { host: string; port: number } {
  const match = /^\[?([^\]]*?)\]?:(\d+)$/.exec(target);
  if (match === null) return { host: target, port: 443 };
  return { host: match[1] ?? '', port: Number(match[2]) };
}

type Reached = { address: string } | { refused: RefusalReason };

/** The proxy's servers, and what they share: the policy file, the log, the resolver. */
class EgressProxy {
  readonly server: Server;
  private readonly forwards: TcpServer[];
  private readonly resolve: (host: string) => Promise<string[]>;
  // A field set by hand: Node.js strips the types of this file, and cannot strip a parameter property.
  private readonly options: EgressProxyOptions;

  constructor(options: EgressProxyOptions) {
    this.options = options;
    this.resolve = options.resolve ?? systemResolve;
    this.server = createServer((incoming, answer) => void this.forward(incoming, answer));
    this.server.on('connect', (incoming: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.on('error', () => undefined);
      void this.tunnel(incoming, socket, head);
    });
    this.forwards = (options.forwards ?? []).map((forward) => portForward(forward, options.host));
    this.server.listen(options.port, options.host);
  }

  async close(): Promise<void> {
    await Promise.all(
      [this.server, ...this.forwards].map(
        (closing) =>
          new Promise<void>((done) => {
            closing.close(() => done());
          }),
      ),
    );
  }

  /** A plain HTTP request, its URL absolute: sent on to the host it names, when it may be. */
  private async forward(incoming: IncomingMessage, answer: ServerResponse): Promise<void> {
    const target = URL.parse(incoming.url ?? '');
    if (target?.protocol !== 'http:') {
      answer.writeHead(400).end();
      return;
    }
    const port = target.port === '' ? 80 : Number(target.port);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const reached = await this.addressOf(host);
    if ('refused' in reached) {
      this.refuse(host, port, reached.refused);
      answer
        .writeHead(403, { 'content-type': 'text/plain' })
        .end(`The sandbox's network policy refuses ${host}.\n`);
      return;
    }
    const upstream = request(
      {
        host: reached.address,
        port,
        method: incoming.method,
        path: `${target.pathname}${target.search}`,
        headers: withoutProxyHeaders(incoming.headers, target.host),
      },
      (response) => {
        answer.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(answer);
      },
    );
    upstream.on('error', () => {
      if (!answer.headersSent) answer.writeHead(502);
      answer.end();
    });
    incoming.pipe(upstream);
  }

  /** A `CONNECT` tunnel, HTTPS most often: opened to the host it names, when it may be. */
  private async tunnel(incoming: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const { host, port } = splitTarget(incoming.url ?? '');
    const reached: Reached = host === '' ? { refused: 'policy' } : await this.addressOf(host);
    if ('refused' in reached) {
      this.refuse(host, port, reached.refused);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(port, reached.address, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    socket.on('close', () => upstream.destroy());
  }

  /** The address to connect to for `host`, or why it may not be reached. */
  private async addressOf(host: string): Promise<Reached> {
    if (!allows(this.options.policyFile, host)) return { refused: 'policy' };
    let addresses: string[];
    try {
      addresses = isIP(host) === 0 ? await this.resolve(host) : [host];
    } catch {
      return { refused: 'unresolved' };
    }
    const [address] = addresses;
    // One private address among them is enough: a name that points inside is refused whole.
    if (address === undefined || addresses.some(this.options.isPrivate ?? isPrivateAddress)) {
      return { refused: 'private-address' };
    }
    return { address };
  }

  /** Logs a refusal: one JSON line, which the client reads back as a blocked request. */
  private refuse(host: string, port: number | undefined, reason: RefusalReason): void {
    const at = new Date().toISOString();
    const entry = { host, ...(port !== undefined && { port }), at, reason };
    try {
      appendFileSync(this.options.logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      // The refusal holds even when it could not be logged.
    }
  }
}

/** A TCP forward of a port of the sandbox, from the proxy's `listen` port. */
function portForward(forward: PortForward, host: string | undefined): TcpServer {
  const tcp = createTcpServer((socket) => {
    socket.on('error', () => undefined);
    const upstream = connect(forward.port, forward.host);
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  tcp.listen(forward.listen, host);
  return tcp;
}

/**
 * Starts the proxy: `CONNECT` tunnels and plain HTTP requests to the hosts the policy allows, read
 * again at each connection, never to a private address once the name is resolved; and a TCP
 * forward for each port of the sandbox published on the host. Each refusal is logged.
 */
export function startEgressProxy(options: EgressProxyOptions): {
  server: Server;
  close: () => Promise<void>;
} {
  const proxy = new EgressProxy(options);
  return { server: proxy.server, close: () => proxy.close() };
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The proxy's settings, from the environment its container is given. */
export function proxyOptionsOf(env: Environment): EgressProxyOptions {
  return {
    policyFile: env['EGRESS_POLICY'] ?? '/egress/policy.json',
    logFile: env['EGRESS_LOG'] ?? '/egress/blocked.jsonl',
    port: Number(env['EGRESS_PORT'] ?? 3128),
    forwards: JSON.parse(env['EGRESS_FORWARDS'] ?? '[]') as PortForward[],
  };
}

// Run as a script, in the proxy's container.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startEgressProxy(proxyOptionsOf(process.env));
}
