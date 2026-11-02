import { describe, expect, it } from 'vitest';

import { stringifyToml } from './toml.js';

describe('stringifyToml', () => {
  it('writes one basic string per key, in order, leaving out what is undefined', () => {
    expect(
      stringifyToml({ name: 'critic', model: undefined, text: 'Two\nlines "quoted" \\' }),
    ).toBe('name = "critic"\ntext = "Two\\nlines \\"quoted\\" \\\\"\n');
  });

  it('escapes the control characters TOML refuses, and replaces a lone surrogate', () => {
    expect(stringifyToml({ text: 'a\u0001b\u007fc\ud800' })).toBe(
      'text = "a\\u0001b\\u007fc\ufffd"\n',
    );
  });
});
