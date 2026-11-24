import { describe, expect, it } from 'vitest';

import { proxyConfig, totalConnectionsFor } from './main.js';

describe('the settings of the proxy', () => {
  const token = 'a-token-of-sixteen-characters';

  it('exits when idle only when told how long to wait, in whole minutes', () => {
    expect(proxyConfig({ SANDBOX_PROXY_TOKEN: token }).idleExitMs).toBeUndefined();
    expect(
      proxyConfig({ SANDBOX_PROXY_TOKEN: token, SANDBOX_PROXY_IDLE_EXIT_MINUTES: '10' }).idleExitMs,
    ).toBe(600_000);
    expect(() =>
      proxyConfig({ SANDBOX_PROXY_TOKEN: token, SANDBOX_PROXY_IDLE_EXIT_MINUTES: '0.5' }),
    ).toThrow('SANDBOX_PROXY_IDLE_EXIT_MINUTES: `0.5` is not a positive integer.');
  });

  it('keeps connections for the base URL routes beyond those of the commands', () => {
    expect(proxyConfig({ SANDBOX_PROXY_TOKEN: token })).toMatchObject({
      maxConnections: 128,
      routeConnections: 32,
    });
    expect(
      proxyConfig({
        SANDBOX_PROXY_TOKEN: token,
        SANDBOX_PROXY_MAX_CONNECTIONS: '256',
        SANDBOX_PROXY_ROUTE_CONNECTIONS: '0',
      }),
    ).toMatchObject({ maxConnections: 256, routeConnections: 0 });
    expect(() =>
      proxyConfig({ SANDBOX_PROXY_TOKEN: token, SANDBOX_PROXY_MAX_CONNECTIONS: '0' }),
    ).toThrow('SANDBOX_PROXY_MAX_CONNECTIONS: `0` is not a positive integer.');
    expect(() =>
      proxyConfig({ SANDBOX_PROXY_TOKEN: token, SANDBOX_PROXY_ROUTE_CONNECTIONS: '-1' }),
    ).toThrow('SANDBOX_PROXY_ROUTE_CONNECTIONS: `-1` is not a non-negative integer.');
  });

  it('holds, for all sandboxes, the connections its descriptors allow', () => {
    const limits = (soft: string) =>
      `Limit                     Soft Limit           Hard Limit           Units\nMax open files            ${soft}               524288               files\n`;
    // Two descriptors for each connection, 1024 kept apart.
    expect(totalConnectionsFor(limits('65536'))).toBe(32_256);
    expect(totalConnectionsFor(limits('unlimited'))).toBe(32_256);
    expect(totalConnectionsFor(undefined)).toBe(32_256);
    expect(proxyConfig({ SANDBOX_PROXY_TOKEN: token }, limits('4096')).totalConnections).toBe(1536);
    expect(
      proxyConfig(
        { SANDBOX_PROXY_TOKEN: token, SANDBOX_PROXY_TOTAL_CONNECTIONS: '1000' },
        limits('4096'),
      ).totalConnections,
    ).toBe(1000);
  });
});
