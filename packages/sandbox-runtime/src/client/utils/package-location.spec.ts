import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { packageRoot, srtRoot } from './package-location.js';

describe('package-location', () => {
  it('finds this package and srt by their names', () => {
    expect(existsSync(join(packageRoot(), 'src', 'client', 'utils', 'package-location.ts'))).toBe(
      true,
    );
    expect(existsSync(join(srtRoot(), 'package.json'))).toBe(true);
    expect(srtRoot()).toMatch(/@anthropic-ai[/+]sandbox-runtime/);
  });
});

describe('packageRoot', () => {
  it('falls back on the application, and says when it finds nothing', () => {
    expect(packageRoot('/')).toBe(packageRoot());
  });
});
