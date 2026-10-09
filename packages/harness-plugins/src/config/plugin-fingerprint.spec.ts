import { describe, expect, it } from 'vitest';

import { pluginFingerprint } from './plugin-fingerprint.js';

describe('pluginFingerprint', () => {
  it('is the same whatever the order of the keys, and changes with any value', () => {
    const a = pluginFingerprint([{ name: 'a', description: 'x', hooks: [{ event: 'Stop' }] }]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(
      pluginFingerprint([
        { hooks: [{ event: 'Stop' }], description: 'x', name: 'a', version: undefined },
      ]),
    ).toBe(a);
    expect(
      pluginFingerprint([{ name: 'a', description: 'y', hooks: [{ event: 'Stop' }] }]),
    ).not.toBe(a);
    expect(pluginFingerprint([])).not.toBe(pluginFingerprint({}));
    expect(pluginFingerprint(undefined)).toBe(pluginFingerprint(null));
  });
});
