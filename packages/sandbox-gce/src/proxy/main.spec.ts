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
});
