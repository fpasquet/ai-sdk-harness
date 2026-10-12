import { describe, expect, it } from 'vitest';

import { InvalidPluginError } from './invalid-plugin-error.js';
import { PluginLoadError } from './plugin-load-error.js';

describe('isInstance', () => {
  it('recognises an error of another copy of the package, which instanceof misses', () => {
    // What a second copy of the class, loaded by a bundler, throws.
    const copy = Object.assign(new Error('Plugin "docs": nope'), {
      [Symbol.for('ai-sdk-harness-plugins.InvalidPluginError')]: true,
    });

    expect(copy instanceof InvalidPluginError).toBe(false);
    expect(InvalidPluginError.isInstance(copy)).toBe(true);
    expect(InvalidPluginError.isInstance(new InvalidPluginError('nope', 'docs'))).toBe(true);
    expect(PluginLoadError.isInstance(new PluginLoadError('/p', 'no manifest'))).toBe(true);
  });

  it('tells the errors apart, and refuses anything else', () => {
    expect(InvalidPluginError.isInstance(new PluginLoadError('/p', 'no manifest'))).toBe(false);
    expect(PluginLoadError.isInstance(new InvalidPluginError('nope'))).toBe(false);
    expect(InvalidPluginError.isInstance(new Error('nope'))).toBe(false);
    expect(InvalidPluginError.isInstance(null)).toBe(false);
  });
});
