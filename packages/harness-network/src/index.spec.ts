import { describe, expect, it } from 'vitest';

import type { HarnessNetwork } from './index.js';

import {
  HARNESS_NETWORK,
  isAllowedHost,
  PROVIDER_HOSTS,
  providerHosts,
  TRUSTED_HOSTS,
} from './index.js';

describe('the presets', () => {
  it('only hold hosts a network policy takes', () => {
    const hosts = [
      ...Object.values(TRUSTED_HOSTS).flat(),
      ...Object.values(PROVIDER_HOSTS).flat(),
      ...Object.values(HARNESS_NETWORK).flatMap((network: HarnessNetwork) => [
        ...network.install,
        ...network.service,
        ...network.optional,
        ...(network.signIn ?? []),
      ]),
      ...providerHosts('google-vertex', { region: 'us-central1' }),
      ...providerHosts('amazon-bedrock', { region: 'us-east-1' }),
      ...providerHosts('azure'),
    ];
    expect(hosts.filter((host) => !isAllowedHost(host))).toEqual([]);
  });
});
