// @ts-check
// Shared Vitest preset. The packages are ESM-only, like the AI SDK they plug into, so the tests
// run them as ESM too: no transform to CommonJS, no module-name mapping.
import { defineConfig, mergeConfig } from 'vitest/config';

// Tests run in a fixed, non-UTC timezone so date handling is deterministic across machines and CI.
process.env.TZ = 'Europe/Paris';

const preset = defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/index.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});

/**
 * The preset, with a package's own settings merged on top.
 *
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function vitestConfig(overrides = {}) {
  const merged = mergeConfig(preset, overrides);
  // `mergeConfig` concatenates arrays: a package naming its own test files means those only.
  const include = overrides.test?.include;
  return include ? { ...merged, test: { ...merged.test, include } } : merged;
}
