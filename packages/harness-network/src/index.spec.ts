import { describe, expect, it } from 'vitest';

import { HARNESS_HOSTS, isAllowedHost, TRUSTED_HOSTS } from './index.js';

describe('the presets', () => {
  it('only hold hosts a network policy takes', () => {
    const hosts = [...Object.values(TRUSTED_HOSTS), ...Object.values(HARNESS_HOSTS)].flat();
    expect(hosts.filter((host) => !isAllowedHost(host))).toEqual([]);
  });
});
