import { vitestConfig } from '@repo/vitest-config';

export default vitestConfig({
  test: {
    // The service runs the programs of `src/in-sandbox/` as separate processes: they are built once,
    // before the suite, aside from `dist/` (see `test/build-helpers.ts`).
    globalSetup: ['test/build-helpers.ts'],
    testTimeout: 20_000,
    coverage: {
      // Run as child processes, in the sandboxes or as the command line: v8 does not see them.
      exclude: ['src/in-sandbox/**', 'src/server/cli.ts'],
    },
  },
});
