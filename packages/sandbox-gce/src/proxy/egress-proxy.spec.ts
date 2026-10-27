import type { AddressInfo } from 'node:net';

import { request } from 'node:http';
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
