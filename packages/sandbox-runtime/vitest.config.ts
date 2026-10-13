import { vitestConfig } from '@repo/vitest-config';

export default vitestConfig({
  test: {
    // The sandboxes run the supervisor of `src/in-sandbox/` as a process of its own: it is built
    // once, before the suite, aside from `dist/` (see `test/build-helpers.ts`).
    globalSetup: ['test/build-helpers.ts'],
    testTimeout: 20_000,
    coverage: {
      // Runs as a child process: v8 does not see it.
      exclude: ['src/in-sandbox/**'],
    },
  },
});
