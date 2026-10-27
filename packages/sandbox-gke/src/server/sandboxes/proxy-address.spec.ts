import { describe, expect, it, vi } from 'vitest';

import { proxyAddress } from './proxy-address.js';

// A resolver of two names: one to an IPv4 address, one to an IPv6 address.
const lookup = vi.hoisted(() =>
  vi.fn((host: string) =>
    Promise.resolve(
      host === 'proxy-v6.sandboxes.svc'
        ? { address: 'fd00::12', family: 6 }
        : { address: '10.8.0.12', family: 4 },
    ),
  ),
);
vi.mock('node:dns/promises', () => ({ lookup }));

describe('the address of the egress proxy', () => {
  it('is given as it is when it is one, IPv4 or IPv6', async () => {
    expect(await proxyAddress('http://10.8.0.12:3128')()).toBe('http://10.8.0.12:3128');
    expect(await proxyAddress('http://[fd00::12]:3128')()).toBe('http://[fd00::12]:3128');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is resolved from a host name once, for pods that have no resolver', async () => {
    const address = proxyAddress('http://proxy.sandboxes.svc:3128');

    expect(await address()).toBe('http://10.8.0.12:3128');
    expect(await address()).toBe('http://10.8.0.12:3128');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('puts an IPv6 address it resolved between brackets', async () => {
    expect(await proxyAddress('http://proxy-v6.sandboxes.svc:3128')()).toBe(
      'http://[fd00::12]:3128',
    );
  });
});
