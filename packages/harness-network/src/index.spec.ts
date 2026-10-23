import { describe, expect, it } from 'vitest';

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
      ...Object.values(HARNESS_NETWORK).flatMap(({ install, service, optional }) => [
        ...install,
        ...service,
        ...optional,
      ]),
      ...providerHosts('google-vertex', { region: 'us-central1' }),
      ...providerHosts('amazon-bedrock', { region: 'us-east-1' }),
      ...providerHosts('azure'),
    ];
    expect(hosts.filter((host) => !isAllowedHost(host))).toEqual([]);
  });
});
