import type { AddressInfo, Socket } from 'node:net';

import { createServer as createHttpServer, request } from 'node:http';
import { connect, createServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EgressPolicy } from './egress-policy.js';

import { silentLogger } from '../common/logger.js';
import { EgressMeter } from './egress-meter.js';
import { EgressProxy } from './egress-proxy.js';

const policy: EgressPolicy = {
  name: 'box',
  allowedHosts: ['allowed.example.com'],
  upstreamHosts: [],
  transformations: [],
  allowPrivateNetwork: false,
};

/** A `CONNECT target` through `proxy`: the status it answers. */
async function connectThrough(proxy: EgressProxy, target: string): Promise<number | undefined> {
  await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, method: 'CONNECT', path: target })
      .on('connect', (response) => {
        response.socket.destroy();
        resolve(response.statusCode);
      })
      .on('error', reject)
      .end();
  });
}

/**
 * Opens a tunnel to `target` through `proxy`, then a TLS connection in it naming `servername`
 * (none when empty): the first bytes the upstream received, empty when the tunnel was cut.
 */
async function tlsThrough(
  proxy: EgressProxy,
  { target, servername }: { target: string; servername: string },
): Promise<Buffer> {
  await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.server.address() as AddressInfo;
  const tunnel = await new Promise<Socket>((resolve, reject) => {
    request({ host: '127.0.0.1', port, method: 'CONNECT', path: target })
      .on('connect', (_response, socket: Socket) => resolve(socket))
      .on('error', reject)
      .end();
  });
  const client = tlsConnect({ socket: tunnel, servername });
  client.on('error', () => undefined);
  const received = await upstreamBytes;
  client.destroy();
  return received;
}

/** The bytes the upstream of the tunnel tests receives first, once a test reads them. */
let upstreamBytes: Promise<Buffer>;

/** A plain request through `proxy` to `path`: the status it answers. */
async function getThrough(proxy: EgressProxy, path: string): Promise<number | undefined> {
  await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (response) => {
      response.resume();
      resolve(response.statusCode);
    })
      .on('error', reject)
      .end();
  });
}

describe('the egress proxy', () => {
  let proxy: EgressProxy;

  afterEach(() => proxy.close());

  describe('through a tunnel', () => {
    const upstream = createServer();
    let upstreamPort: number;
    const tunnelPolicy: EgressPolicy = {
      ...policy,
      allowedHosts: ['localhost', '127.0.0.1'],
      allowPrivateNetwork: true,
    };

    afterEach(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    /** The upstream, recording the first bytes of a connection, or none once it is cut. */
    async function listenUpstream(): Promise<void> {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      upstreamPort = (upstream.address() as AddressInfo).port;
      upstreamBytes = new Promise((resolve) => {
        upstream.once('connection', (socket) => {
          socket.once('data', resolve);
          socket.once('close', () => resolve(Buffer.alloc(0)));
        });
      });
    }

    it('passes on a TLS connection that names the host of its tunnel', async () => {
      await listenUpstream();
      proxy = new EgressProxy(() => tunnelPolicy, silentLogger, { tunnelPort: upstreamPort });

      const received = await tlsThrough(proxy, {
        target: 'localhost:443',
        servername: 'localhost',
      });

      expect(received[0]).toBe(22);
    });

    it('cuts a tunnel whose TLS names another server, as a CDN would serve it', async () => {
      await listenUpstream();
      const info = vi.fn();
      proxy = new EgressProxy(
        () => tunnelPolicy,
        { ...silentLogger, info },
        { tunnelPort: upstreamPort },
      );

      const received = await tlsThrough(proxy, {
        target: 'localhost:443',
        servername: 'attacker.workers.dev',
      });

      expect(received.length).toBe(0);
      expect(info).toHaveBeenCalledWith(
        'Refused localhost:443 to box: A tunnel to localhost may not name attacker.workers.dev in its TLS.',
      );
    });

    it('cuts a tunnel to a name whose TLS names no server', async () => {
      await listenUpstream();
      const info = vi.fn();
      proxy = new EgressProxy(
        () => tunnelPolicy,
        { ...silentLogger, info },
        { tunnelPort: upstreamPort },
      );

      const received = await tlsThrough(proxy, { target: 'localhost:443', servername: '' });

      expect(received.length).toBe(0);
      expect(info).toHaveBeenCalledWith(
        'Refused localhost:443 to box: A tunnel to localhost must name it in its TLS (SNI).',
      );
    });

    it('lets a tunnel to an address name no server, and no other', async () => {
      await listenUpstream();
      proxy = new EgressProxy(() => tunnelPolicy, silentLogger, { tunnelPort: upstreamPort });

      const received = await tlsThrough(proxy, { target: '127.0.0.1:443', servername: '' });

      expect(received[0]).toBe(22);
    });
  });

  it('keeps an idle connection open longer than the runtimes keep theirs', () => {
    proxy = new EgressProxy(() => policy);

    // Codex's client keeps an idle connection for 90 s: the proxy must not close it first.
    expect(proxy.server.keepAliveTimeout).toBeGreaterThan(90_000);
    expect(proxy.server.headersTimeout).toBeGreaterThan(proxy.server.keepAliveTimeout);
  });

  // Six real seconds: Node.js times an idle connection out on its socket, out of fake timers' reach.
  it(
    'serves a request on a connection idle past Node.js default keep-alive',
    { timeout: 15_000 },
    async () => {
      proxy = new EgressProxy(() => policy);
      await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
      const { port } = proxy.server.address() as AddressInfo;
      const socket = connect({ host: '127.0.0.1', port });
      await new Promise((resolve) => socket.once('connect', resolve));
      /** A plain request on that same connection: the status line it answers, or how it ended. */
      const ask = (): Promise<string> =>
        new Promise((resolve) => {
          socket.once('data', (chunk: Buffer) => resolve(chunk.toString().split('\r\n')[0] ?? ''));
          socket.once('close', () => resolve('closed'));
          socket.write('GET /not-a-route HTTP/1.1\r\nHost: proxy\r\n\r\n');
        });

      expect(await ask()).toBe('HTTP/1.1 403 Forbidden');
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(await ask()).toBe('HTTP/1.1 403 Forbidden');
      socket.destroy();
    },
  );

  it('logs a host it refuses, with the sandbox that asked for it', async () => {
    const info = vi.fn();
    proxy = new EgressProxy(() => policy, { ...silentLogger, info });

    const status = await connectThrough(proxy, 'denied.example.com:443');

    expect(status).toBe(403);
    expect(info).toHaveBeenCalledWith(
      'Refused denied.example.com:443 to box: denied.example.com is not reachable from the sandbox.',
    );
  });

  it('cuts the connections of a sandbox beyond both its limits, and logs it once', async () => {
    const warn = vi.fn();
    proxy = new EgressProxy(
      () => policy,
      { ...silentLogger, warn },
      { maxConnections: 1, routeConnections: 1 },
    );
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.server.address() as AddressInfo;
    /** A connection to the proxy: whether it is still open once the proxy saw it. */
    const open = async (): Promise<{ cut: boolean; end: () => void }> => {
      const socket = connect({ host: '127.0.0.1', port });
      await new Promise((resolve) => socket.once('connect', resolve));
      const cut = await new Promise<boolean>((resolve) => {
        socket.once('close', () => resolve(true));
        setTimeout(() => resolve(false), 100);
      });
      return { cut, end: () => socket.destroy() };
    };

    const [first, second, third, fourth] = [await open(), await open(), await open(), await open()];
    first?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await open();

    expect([first?.cut, second?.cut, third?.cut, fourth?.cut, after.cut]).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    // Connections that sent nothing yet count against both limits together.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'box reached its limit: 2 connections are open, base URL routes included, the most it may. More are refused until some close: 1 for the commands, and 1 more for the base URL routes.',
    );
    second?.end();
    after.end();
  });

  describe('at the limit of a sandbox', () => {
    const upstream = createHttpServer((_req, res) => res.end('ok'));
    let port: number;
    let upstreamPort: number;
    const limitPolicy: EgressPolicy = {
      ...policy,
      allowedHosts: ['127.0.0.1'],
      allowPrivateNetwork: true,
    };
    const held: Socket[] = [];

    afterEach(async () => {
      for (const socket of held.splice(0)) socket.destroy();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    async function listen(proxyOf: (upstreamPort: number) => EgressProxy): Promise<void> {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      upstreamPort = (upstream.address() as AddressInfo).port;
      proxy = proxyOf(upstreamPort);
      await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
      port = (proxy.server.address() as AddressInfo).port;
    }

    /** A tunnel a command opens and keeps: the status of its `CONNECT`. */
    const tunnel = (): Promise<number | undefined> =>
      new Promise((resolve, reject) => {
        request({ host: '127.0.0.1', port, method: 'CONNECT', path: '127.0.0.1:443', agent: false })
          .on('connect', (response, socket: Socket) => {
            held.push(socket);
            resolve(response.statusCode);
          })
          .on('error', reject)
          .end();
      });

    /** A request of the runtime to its provider, through its base URL route. */
    const route = (): Promise<number | string> =>
      new Promise((resolve) => {
        request(
          {
            host: '127.0.0.1',
            port,
            path: `/http/127.0.0.1:${upstreamPort}/v1/messages`,
            agent: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        )
          .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
          .end();
      });

    it('reaches the base URLs while the commands hold every connection they may', async () => {
      await listen(
        (tunnelPort) =>
          new EgressProxy(() => limitPolicy, silentLogger, { maxConnections: 2, tunnelPort }),
      );
      expect([await tunnel(), await tunnel()]).toEqual([200, 200]);

      expect(await route()).toBe(200);
    });

    it('refuses a command beyond its limit, says why, and logs when the sandbox reaches it and goes back under', async () => {
      const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
      await listen(
        (tunnelPort) =>
          new EgressProxy(() => limitPolicy, logger, { maxConnections: 2, tunnelPort }),
      );
      /** A plain HTTP request a command sends through `HTTP_PROXY`. */
      const plain = (): Promise<{ status?: number; body: string }> =>
        new Promise((resolve, reject) => {
          request(
            {
              host: '127.0.0.1',
              port,
              path: `http://127.0.0.1:${upstreamPort}/package.tgz`,
              agent: false,
            },
            (response) => {
              let body = '';
              response.on('data', (chunk: Buffer) => (body += chunk.toString()));
              response.on('end', () => resolve({ status: response.statusCode, body }));
            },
          )
            .on('error', reject)
            .end();
        });

      expect([await tunnel(), await tunnel(), await tunnel()]).toEqual([200, 200, 503]);
      expect(await plain()).toEqual({
        status: 503,
        body: 'The sandbox holds the most connections its commands may: 2. Close some and try again.\n',
      });
      expect(await route()).toBe(200);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'box reached its limit: its commands hold 2 connections, the most it may. More are refused until some close: 2 for the commands, and 32 more for the base URL routes.',
      );

      // Its tunnels close: back under three quarters of its limit, the refusals counted, once.
      for (const socket of held.splice(0)) socket.destroy();
      await vi.waitFor(() =>
        expect(logger.info).toHaveBeenCalledWith(
          'box is back under its limit: 1 connection open, 1 of its commands; 2 refused meanwhile.',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        logger.info.mock.calls.filter(([message]) => String(message).includes('back under')),
      ).toHaveLength(1);
      expect(await tunnel()).toBe(200);
    });
  });

  describe('at the limit of the proxy', () => {
    const upstream = createHttpServer((_req, res) => res.end('ok'));
    const held: Socket[] = [];

    afterEach(async () => {
      for (const socket of held.splice(0)) socket.destroy();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    it('refuses with a reason beyond its total, keeps a share for the routes, and logs it', async () => {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstream.address() as AddressInfo).port;
      const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
      // 4 connections for the whole proxy, 1 of them kept for the routes; the sandbox's own
      // limits well above.
      proxy = new EgressProxy(
        () => ({ ...policy, allowedHosts: ['127.0.0.1'], allowPrivateNetwork: true }),
        logger,
        { maxConnections: 100, totalConnections: 4, tunnelPort: upstreamPort },
      );
      await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
      const { port } = proxy.server.address() as AddressInfo;
      /** A tunnel a command opens: its status and the first line of its body; kept when open. */
      const tunnel = (): Promise<string> =>
        new Promise((resolve, reject) => {
          request({
            host: '127.0.0.1',
            port,
            method: 'CONNECT',
            path: '127.0.0.1:443',
            agent: false,
          })
            .on('connect', (response, socket: Socket, head: Buffer) => {
              held.push(socket);
              // What came after the status line: the reason of a refusal.
              const reason = head.toString().trim();
              resolve(
                reason === '' ? String(response.statusCode) : `${response.statusCode} ${reason}`,
              );
            })
            .on('error', reject)
            .end();
        });
      const route = (): Promise<number | undefined> =>
        new Promise((resolve, reject) => {
          request(
            { host: '127.0.0.1', port, path: `/http/127.0.0.1:${upstreamPort}/v1`, agent: false },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          )
            .on('error', reject)
            .end();
        });
      /** A connection that says nothing: what the proxy writes to it before closing it, if anything. */
      const silent = (): Promise<string> =>
        new Promise((resolve) => {
          const socket = connect({ host: '127.0.0.1', port });
          held.push(socket);
          let text = '';
          socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
          socket.once('close', () => resolve(text));
          setTimeout(() => resolve('open'), 200);
        });

      expect([await tunnel(), await tunnel(), await tunnel()]).toEqual(['200', '200', '200']);
      // The commands of all sandboxes hold their 3: the fourth goes to the routes alone.
      expect(await tunnel()).toBe(
        '503 The proxy holds the most connections it may, for all its sandboxes. Try again in a moment.',
      );
      // Once the proxy closed the refused tunnel's connection, the route has its share.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await route()).toBe(200);
      expect(await silent()).toBe('open');
      // All 4 are open: one more is refused, with the reason, before it says anything.
      expect(await silent()).toMatch(
        /^HTTP\/1\.1 503 Service Unavailable\r\n[^]*The proxy holds the most/,
      );

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'The proxy reached its limit: the commands of its sandboxes hold 3 connections, the most it may for all its sandboxes (4, 3 of them for the commands). More are refused until some close. Holding the most: box (4).',
      );
      for (const socket of held.splice(0)) socket.destroy();
      await vi.waitFor(() =>
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringMatching(/^The proxy is back under its limit: .*; 2 refused meanwhile\.$/),
        ),
      );
    });
  });

  it('logs a machine it serves no sandbox for, and the host alone of a plain request', async () => {
    const info = vi.fn();
    proxy = new EgressProxy(() => undefined, { ...silentLogger, info });

    expect(await connectThrough(proxy, 'allowed.example.com:443')).toBe(403);
    proxy.close();
    proxy = new EgressProxy(() => policy, { ...silentLogger, info });
    expect(await getThrough(proxy, 'http://denied.example.com/path?token=placeholder')).toBe(403);

    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/^Refused allowed\.example\.com:443 to .*127\.0\.0\.1: /),
    );
    expect(info).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Refused denied\.example\.com to box: /),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('placeholder');
  });
});

describe('the direct connections of programs that ignore the proxy variables', () => {
  const directPolicy: EgressPolicy = {
    ...policy,
    allowedHosts: ['localhost'],
    allowPrivateNetwork: true,
  };
  let proxy: EgressProxy;
  /** What each test opened, closed after it: its upstream and every socket. */
  let opened: { close: () => void }[] = [];

  afterEach(() => {
    proxy.close();
    for (const one of opened) one.close();
    opened = [];
  });

  /**
   * An upstream on 127.0.0.1: the first bytes a connection to it carries, empty once it is cut,
   * and whether any connection reached it.
   */
  async function listenUpstream(): Promise<{
    port: number;
    first: Promise<Buffer>;
    reached: () => boolean;
  }> {
    const upstream = createServer();
    const sockets: Socket[] = [];
    let reached = false;
    const first = new Promise<Buffer>((resolve) => {
      upstream.on('connection', (socket) => {
        reached = true;
        sockets.push(socket);
        socket.once('data', resolve);
        socket.once('close', () => resolve(Buffer.alloc(0)));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    opened.push({
      close: () => {
        for (const socket of sockets) socket.destroy();
        upstream.close();
      },
    });
    return { port: (upstream.address() as AddressInfo).port, first, reached: () => reached };
  }

  /** A connection to the proxy's TLS listener, made by `open`: settled once the proxy closes it. */
  async function direct(open: (port: number) => Socket): Promise<void> {
    if (!proxy.tlsServer.listening) {
      await new Promise<void>((resolve) => proxy.tlsServer.listen(0, '127.0.0.1', resolve));
    }
    const socket = open((proxy.tlsServer.address() as AddressInfo).port);
    socket.on('error', () => undefined);
    opened.push({ close: () => socket.destroy() });
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  }

  it('relays a TLS connection to the allowed host it names, as it is, its bytes counted', async () => {
    const { port, first } = await listenUpstream();
    const meter = new EgressMeter();
    proxy = new EgressProxy(() => ({ ...directPolicy, meter }), silentLogger, { tunnelPort: port });
    await new Promise<void>((resolve) => proxy.tlsServer.listen(0, '127.0.0.1', resolve));
    const client = tlsConnect({
      host: '127.0.0.1',
      port: (proxy.tlsServer.address() as AddressInfo).port,
      servername: 'localhost',
    });
    client.on('error', () => undefined);
    opened.push({ close: () => client.destroy() });

    const received = await first;

    // A TLS handshake record: the ClientHello, passed on untouched.
    expect(received[0]).toBe(0x16);
    expect(meter.usage()).toMatchObject({ connections: 1, bytesRead: received.length });
  });

  it('cuts a TLS connection to a host the sandbox may not reach, or that names none, or no TLS', async () => {
    const info = vi.fn();
    const { port, reached } = await listenUpstream();
    proxy = new EgressProxy(() => directPolicy, { ...silentLogger, info }, { tunnelPort: port });

    await direct((at) =>
      tlsConnect({ host: '127.0.0.1', port: at, servername: 'other.example.com' }),
    );
    await direct((at) => tlsConnect({ host: '127.0.0.1', port: at }));
    await direct((at) => {
      const socket = connect(at, '127.0.0.1');
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      return socket;
    });

    expect(reached()).toBe(false);
    expect(info).toHaveBeenCalledWith(
      'Refused other.example.com to box: other.example.com is not reachable from the sandbox.',
    );
    expect(info).toHaveBeenCalledWith(
      'Refused ? to box: A direct TLS connection must name its host (SNI).',
    );
    expect(info).toHaveBeenCalledWith('Refused ? to box: Only TLS reaches the proxy on 443.');
  });

  it('cuts a TLS connection from a machine that is no sandbox', async () => {
    const { port, reached } = await listenUpstream();
    proxy = new EgressProxy(() => undefined, silentLogger, { tunnelPort: port });

    await direct((at) => tlsConnect({ host: '127.0.0.1', port: at, servername: 'localhost' }));

    expect(reached()).toBe(false);
  });

  it('sends a plain HTTP request on to its allowed Host, and refuses another', async () => {
    const answering = createHttpServer((req, res) =>
      res.end(`seen ${req.headers.host} ${req.url}`),
    );
    await new Promise<void>((resolve) => answering.listen(0, '127.0.0.1', resolve));
    opened.push({
      close: () => {
        answering.closeAllConnections();
        answering.close();
      },
    });
    const upstreamPort = (answering.address() as AddressInfo).port;
    proxy = new EgressProxy(() => directPolicy);
    await new Promise<void>((resolve) => proxy.httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.httpServer.address() as AddressInfo;
    const get = (host: string): Promise<{ status?: number; body: string }> =>
      new Promise((resolve, reject) => {
        request(
          { host: '127.0.0.1', port, path: '/simple/?q=1', headers: { host } },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => (body += chunk.toString()));
            response.on('end', () => resolve({ status: response.statusCode, body }));
          },
        )
          .on('error', reject)
          .end();
      });

    const allowed = await get(`localhost:${upstreamPort}`);
    const other = await get('other.example.com');

    expect(allowed).toEqual({ status: 200, body: `seen localhost:${upstreamPort} /simple/?q=1` });
    expect(other.status).toBe(403);
  });
});
