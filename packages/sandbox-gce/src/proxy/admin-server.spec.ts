import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { createAdminServer } from './admin-server.js';
import { SandboxRegistry } from './registry.js';

const TOKEN = 'proxy-token';

describe('the administration API of the egress proxy', () => {
  let registry: SandboxRegistry;
  let server: Server;
  let url: string;
  const error = vi.fn();

  /** Calls the API with its token. */
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(async () => {
    error.mockReset();
    registry = new SandboxRegistry();
    server = createAdminServer({ registry, token: TOKEN, logger: { ...silentLogger, error } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );

  it('registers a sandbox, what it may reach and its credentials', async () => {
    const transformation = {
      match: { host: 'api.anthropic.com' },
      transform: { headers: { authorization: 'Bearer a-real-credential-value' } },
    };

    await call('PUT', '/v1/sandboxes/box', { address: '10.0.0.3' });
    await call('PUT', '/v1/sandboxes/box/network', { allowedHosts: ['github.com'] });
    await call('PUT', '/v1/sandboxes/box/transformations', { transformations: [] });
    await call('POST', '/v1/sandboxes/box/transformations', { transformations: [transformation] });
    const screened = await call('POST', '/v1/sandboxes/box/screen', {
      texts: ['echo a-real-credential-value'],
    });

    expect(registry.policyFor('10.0.0.3')).toMatchObject({
      allowedHosts: ['github.com'],
      transformations: [transformation],
    });
    expect(await screened.json()).toEqual({ refused: true });

    expect((await call('DELETE', '/v1/sandboxes/box')).status).toBe(204);
    expect(registry.policyFor('10.0.0.3')).toBeUndefined();
  });

  it('lists its sandboxes, and forgets one only by the registration it listed', async () => {
    await call('PUT', '/v1/sandboxes/box', { address: '10.0.0.3' });
    const listed = await call('GET', '/v1/sandboxes');
    await call('PUT', '/v1/sandboxes/box', { address: '10.0.0.3' });

    const stale = await call('DELETE', '/v1/sandboxes/box?serial=1');
    const invalid = await call('DELETE', '/v1/sandboxes/box?serial=one');

    expect(await listed.json()).toEqual({
      sandboxes: [{ name: 'box', address: '10.0.0.3', serial: 1 }],
    });
    expect([stale.status, invalid.status]).toEqual([204, 400]);
    expect(registry.policyFor('10.0.0.3')).toBeDefined();
    await call('DELETE', '/v1/sandboxes/box?serial=2');
    expect(registry.policyFor('10.0.0.3')).toBeUndefined();
  });

  it('answers its health to anyone, and nothing else without its token', async () => {
    const health = await fetch(`${url}/health`);
    const missing = await fetch(`${url}/v1/sandboxes/box`, { method: 'DELETE' });
    const wrong = await fetch(`${url}/v1/sandboxes/box`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer wrong' },
    });

    expect(await health.json()).toMatchObject({ status: 'ok' });
    expect([missing.status, wrong.status]).toEqual([401, 401]);
  });

  it('refuses an unknown route, a sandbox it does not know and an invalid body', async () => {
    const route = await call('POST', '/v1/sandboxes/box/unknown');
    const path = await call('GET', '/elsewhere');
    const unknown = await call('PUT', '/v1/sandboxes/box/network', { allowedHosts: [] });
    const invalid = await call('PUT', '/v1/sandboxes/box', {});

    expect([route.status, path.status, unknown.status, invalid.status]).toEqual([
      404, 404, 404, 400,
    ]);
    expect(await invalid.json()).toEqual({ error: '`address` is required.' });
    expect(error).not.toHaveBeenCalled();
  });

  it('reports an error it did not expect', async () => {
    vi.spyOn(registry, 'register').mockImplementation(() => {
      throw new Error('out of memory');
    });

    const response = await call('PUT', '/v1/sandboxes/box', { address: '10.0.0.3' });

    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledExactlyOnceWith('PUT /v1/sandboxes/box failed: out of memory');
  });
});
