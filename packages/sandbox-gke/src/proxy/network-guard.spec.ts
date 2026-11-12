import type { LookupAddress } from 'node:dns';

import { describe, expect, it } from 'vitest';

import { isPrivateAddress, publicOnlyLookup } from './network-guard.js';

/** What `publicOnlyLookup` answers for `hostname`. */
const lookUp = (
  hostname: string,
  all: boolean,
): Promise<{ address?: LookupAddress[] | string; error?: NodeJS.ErrnoException | null }> =>
  new Promise((resolve) => {
    publicOnlyLookup(hostname, { all }, (error, address) => resolve({ error, address }));
  });

describe('the network guard', () => {
  it('tells private addresses from public ones', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:169.254.169.254',
      // NAT64 and 6to4 addresses carrying a private IPv4 one.
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b::7f00:1',
      '2002:a9fe:a9fe::1',
      '2002:c0a8:101::',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '2001:4860:4860::8888',
      '64:ff9b::808:808',
      '2002:808:808::1',
      'not an address',
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('refuses a name resolving to a private address', async () => {
    const { error } = await lookUp('localhost', false);

    expect(error?.code).toBe('EPRIVATE');
  });

  it('answers a public name like a plain lookup, one address or all of them', async () => {
    // An IP address resolves to itself, without the network.
    expect(await lookUp('8.8.8.8', false)).toMatchObject({ error: null, address: '8.8.8.8' });
    expect(await lookUp('8.8.8.8', true)).toMatchObject({
      error: null,
      address: [{ address: '8.8.8.8', family: 4 }],
    });
  });

  it('passes on a failed resolution', async () => {
    const { error } = await lookUp('nonexistent.invalid', false);

    expect(error?.code).toMatch(/ENOTFOUND|EAI_AGAIN/);
  });
});
