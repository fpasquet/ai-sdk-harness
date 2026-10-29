import type { AddressInfo, Socket } from 'node:net';

import { request } from 'node:http';
import { createServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EgressPolicy } from './egress-policy.js';

import { silentLogger } from '../common/logger.js';
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
      proxy = new EgressProxy(() => tunnelPolicy, silentLogger, upstreamPort);

      const received = await tlsThrough(proxy, {
        target: 'localhost:443',
        servername: 'localhost',
      });

      expect(received[0]).toBe(22);
    });

    it('cuts a tunnel whose TLS names another server, as a CDN would serve it', async () => {
      await listenUpstream();
      const info = vi.fn();
      proxy = new EgressProxy(() => tunnelPolicy, { ...silentLogger, info }, upstreamPort);

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
      proxy = new EgressProxy(() => tunnelPolicy, { ...silentLogger, info }, upstreamPort);

      const received = await tlsThrough(proxy, { target: 'localhost:443', servername: '' });

      expect(received.length).toBe(0);
      expect(info).toHaveBeenCalledWith(
        'Refused localhost:443 to box: A tunnel to localhost must name it in its TLS (SNI).',
      );
    });

    it('lets a tunnel to an address name no server, and no other', async () => {
      await listenUpstream();
      proxy = new EgressProxy(() => tunnelPolicy, silentLogger, upstreamPort);

      const received = await tlsThrough(proxy, { target: '127.0.0.1:443', servername: '' });

      expect(received[0]).toBe(22);
    });
  });

  it('logs a host it refuses, with the sandbox that asked for it', async () => {
    const info = vi.fn();
    proxy = new EgressProxy(() => policy, { ...silentLogger, info });

    const status = await connectThrough(proxy, 'denied.example.com:443');

    expect(status).toBe(403);
    expect(info).toHaveBeenCalledWith(
      'Refused denied.example.com:443 to box: denied.example.com is not reachable from the sandbox.',
    );
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
