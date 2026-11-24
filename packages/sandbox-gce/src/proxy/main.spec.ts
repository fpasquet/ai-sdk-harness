import { describe, expect, it } from 'vitest';

import { proxyConfig } from './main.js';

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
});
