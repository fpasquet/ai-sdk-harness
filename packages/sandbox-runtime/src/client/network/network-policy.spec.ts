import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { describe, expect, it } from 'vitest';

import { domainsOf } from './network-policy.js';

describe('domainsOf', () => {
  it('lists nothing for deny-all, and the hosts and single addresses of a custom policy', () => {
    expect(domainsOf({ mode: 'deny-all' })).toEqual([]);
    expect(
      domainsOf({
        mode: 'custom',
        allowedHosts: ['example.com'],
        allowedCIDRs: ['10.0.0.1', '10.0.0.2/32', '2001:db8::1/128'],
      }),
    ).toEqual(['example.com', '10.0.0.1', '10.0.0.2', '[2001:db8::1]']);
    expect(domainsOf({ mode: 'custom', allowedCIDRs: ['10.0.0.1'] })).toEqual(['10.0.0.1']);
  });

  it('refuses what srt cannot express', () => {
    expect(() => domainsOf({ mode: 'allow-all' })).toThrow(HarnessCapabilityUnsupportedError);
    expect(() => domainsOf({ mode: 'custom', allowedCIDRs: ['10.0.0.0/8'] })).toThrow('range');
    expect(() => domainsOf({ mode: 'custom', allowedCIDRs: ['not-an-address'] })).toThrow('range');
    expect(() =>
      domainsOf({ mode: 'custom', allowedHosts: ['example.com'], deniedCIDRs: ['10.0.0.0/8'] }),
    ).toThrow('cannot deny');
  });
});
