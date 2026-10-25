import { describe, expect, it } from 'vitest';

import { proxyAddress } from './proxy-address.js';

describe('the address of the egress proxy', () => {
  it('is given as it is when it is one', async () => {
    expect(await proxyAddress('http://10.8.0.12:3128')()).toBe('http://10.8.0.12:3128');
  });

  it('is resolved from a host name, for pods that have no resolver', async () => {
    expect(await proxyAddress('http://localhost:3128')()).toMatch(
      /^http:\/\/(127\.0\.0\.1|\[::1\]):3128$/,
    );
  });
});
