import type { AddressInfo, Server } from 'node:net';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  allows,
  isPrivateAddress,
  matchesHost,
  proxyOptionsOf,
  readPolicy,
  startEgressProxy,
} from './egress-proxy.js';

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

const listening = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(portOf(server)));
  });

const closing = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe('isPrivateAddress', () => {
  it.each([
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.17.0.2',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::10.0.0.1',
    'not an address',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.215.14', '104.20.23.154', '2606:4700:10::6814:179a', '::ffff:104.20.23.154'])(
    'lets %s through',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('matchesHost', () => {
  it('matches a name as listed, or a subdomain of a wildcard, never the domain itself', () => {
    const hosts = ['github.com', '*.githubusercontent.com'];
    expect(matchesHost(hosts, 'GitHub.com.')).toBe(true);
    expect(matchesHost(hosts, 'raw.githubusercontent.com')).toBe(true);
    expect(matchesHost(hosts, 'githubusercontent.com')).toBe(false);
    expect(matchesHost(hosts, 'api.github.com')).toBe(false);
    expect(matchesHost(hosts, 'evilgithub.com')).toBe(false);
    expect(matchesHost(hosts, '')).toBe(false);
  });
});

describe('the policy file', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'egress-policy-'));
    file = join(directory, 'policy.json');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('is read as it stands at each call', async () => {
    await writeFile(file, JSON.stringify({ mode: 'custom', allowedHosts: ['example.com', 1] }));
    expect(readPolicy(file)).toEqual({ mode: 'custom', allowedHosts: ['example.com'] });
    expect(allows(file, 'example.com')).toBe(true);
    expect(allows(file, 'example.org')).toBe(false);

    await writeFile(file, JSON.stringify({ mode: 'allow-all' }));
    expect(allows(file, 'example.org')).toBe(true);
    await writeFile(file, JSON.stringify({ mode: 'deny-all', allowedHosts: ['example.org'] }));
    expect(allows(file, 'example.org')).toBe(false);
  });

  it('refuses everything when it is missing or unreadable', async () => {
    expect(readPolicy(join(directory, 'missing.json'))).toEqual({ mode: 'deny-all' });
    await writeFile(file, '{ not json');
    expect(allows(file, 'example.com')).toBe(false);
    await writeFile(file, JSON.stringify({ mode: 'custom' }));
    expect(readPolicy(file)).toEqual({ mode: 'deny-all' });
  });
});

describe('startEgressProxy', () => {
  let directory: string;
  let policyFile: string;
  let logFile: string;
  let upstream: Server;
  let upstreamPort: number;
  let proxy: ReturnType<typeof startEgressProxy>;
  let proxyPort: number;

  /** Upstream hosts all resolve to the local test server, which the guard lets through. */
  const start = (options: { isPrivate?: (address: string) => boolean } = {}) => {
    proxy = startEgressProxy({
      policyFile,
      logFile,
      port: 0,
      host: '127.0.0.1',
      resolve: (host) =>
        host === 'nowhere.test'
          ? Promise.reject(new Error('ENOTFOUND'))
          : Promise.resolve(['127.0.0.1']),
      isPrivate: options.isPrivate ?? (() => false),
    });
    return new Promise<void>((resolve) => {
      proxy.server.once('listening', () => {
        proxyPort = portOf(proxy.server);
        resolve();
      });
    });
  };

  const policy = (value: unknown) => writeFile(policyFile, JSON.stringify(value));

  /** A `CONNECT` through the proxy: the status it answered, and what the tunnel echoed. */
  const tunnel = (target: string): Promise<{ status: number; echoed?: string }> =>
    new Promise((resolve, reject) => {
      const connecting = request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: target,
      });
      connecting.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          resolve({ status: response.statusCode ?? 0 });
          return;
        }
        socket.once('data', (data: Buffer) => {
          socket.destroy();
          resolve({ status: 200, echoed: data.toString() });
        });
        socket.write('ping');
      });
      connecting.on('error', reject);
      connecting.end();
    });

  const logged = async () =>
    (await readFile(logFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'egress-proxy-'));
    policyFile = join(directory, 'policy.json');
    logFile = join(directory, 'blocked.jsonl');
    await writeFile(logFile, '');
    upstream = createTcpServer((socket) => socket.pipe(socket));
    upstreamPort = await listening(upstream);
  });
  afterEach(async () => {
    await proxy?.close();
    await closing(upstream);
    await rm(directory, { recursive: true, force: true });
  });

  it('opens a tunnel to an allowed host, and refuses the others, logging each refusal', async () => {
    await policy({ mode: 'custom', allowedHosts: ['allowed.test'] });
    await start();

    expect(await tunnel(`allowed.test:${upstreamPort}`)).toEqual({ status: 200, echoed: 'ping' });
    expect(await tunnel('refused.test:443')).toEqual({ status: 403 });
    expect(await logged()).toEqual([
      { host: 'refused.test', port: 443, at: expect.any(String) as unknown, reason: 'policy' },
    ]);
  });

  it('reads the policy again at each connection', async () => {
    await policy({ mode: 'deny-all' });
    await start();
    expect((await tunnel(`later.test:${upstreamPort}`)).status).toBe(403);

    await policy({ mode: 'custom', allowedHosts: ['*.test'] });
    expect((await tunnel(`later.test:${upstreamPort}`)).status).toBe(200);
  });

  it('never reaches a private address, whatever the policy, nor a name that does not resolve', async () => {
    await policy({ mode: 'allow-all' });
    await start({ isPrivate: isPrivateAddress });

    expect((await tunnel(`inside.test:${upstreamPort}`)).status).toBe(403);
    expect((await tunnel('169.254.169.254:80')).status).toBe(403);
    expect((await tunnel('nowhere.test:443')).status).toBe(403);
    expect((await logged()).map(({ host, reason }) => [host, reason])).toEqual([
      ['inside.test', 'private-address'],
      ['169.254.169.254', 'private-address'],
      ['nowhere.test', 'unresolved'],
    ]);
  });

  it('sends a plain HTTP request on to an allowed host, its proxy headers left out', async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const web = createServer((incoming, answer) => {
      seen.push(incoming.headers);
      answer.end(`${incoming.method} ${incoming.url}`);
    });
    const webPort = await listening(web);
    await policy({ mode: 'custom', allowedHosts: ['web.test'] });
    await start();

    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sent = request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            path: url,
            headers: { 'proxy-authorization': 'Basic secret', 'proxy-connection': 'keep-alive' },
          },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => (body += chunk.toString()));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        sent.on('error', reject);
        sent.end();
      });

    expect(await get(`http://web.test:${webPort}/path?q=1`)).toEqual({
      status: 200,
      body: 'GET /path?q=1',
    });
    expect(seen[0]?.host).toBe(`web.test:${webPort}`);
    expect(seen[0]).not.toHaveProperty('proxy-authorization');
    expect((await get('http://other.test/')).status).toBe(403);
    expect((await get('/not-absolute')).status).toBe(400);
    await closing(web);
  });

  it('forwards a port of the sandbox', async () => {
    await policy({ mode: 'deny-all' });
    const forwarded = createTcpServer();
    const listen = await listening(forwarded);
    await closing(forwarded);
    proxy = startEgressProxy({
      policyFile,
      logFile,
      port: 0,
      host: '127.0.0.1',
      forwards: [{ listen, host: '127.0.0.1', port: upstreamPort }],
    });

    const echoed = await new Promise<string>((resolve, reject) => {
      const attempt = (tries: number) => {
        const socket = connect(listen, '127.0.0.1', () => socket.write('pong'));
        socket.once('data', (data: Buffer) => {
          socket.destroy();
          resolve(data.toString());
        });
        socket.once('error', (error) =>
          tries > 0 ? setTimeout(() => attempt(tries - 1), 20) : reject(error),
        );
      };
      attempt(20);
    });
    expect(echoed).toBe('pong');
  });
});

describe('proxyOptionsOf', () => {
  it('reads the settings the container is given', () => {
    expect(
      proxyOptionsOf({
        EGRESS_POLICY: '/state/policy.json',
        EGRESS_LOG: '/state/blocked.jsonl',
        EGRESS_PORT: '3129',
        EGRESS_FORWARDS: '[{"listen":40000,"host":"sandbox","port":8080}]',
      }),
    ).toEqual({
      policyFile: '/state/policy.json',
      logFile: '/state/blocked.jsonl',
      port: 3129,
      forwards: [{ listen: 40_000, host: 'sandbox', port: 8080 }],
    });
    expect(proxyOptionsOf({})).toMatchObject({ port: 3128, forwards: [] });
  });
});
