import { vitestConfig } from '@repo/vitest-config';

export default vitestConfig({
  test: {
    // The fake Compute Engine boots each machine as an agent process of its own, built once, before
    // the suite, aside from `dist/` (see `test/build-helpers.ts`).
    globalSetup: ['test/build-helpers.ts'],
    testTimeout: 20_000,
    coverage: {
      // Run as child processes, in the machines or as the command line: v8 does not see them.
      exclude: [
        'src/in-vm/!(environment).ts',
        'src/proxy/main.ts',
        'src/server/main.ts',
        'src/cli.ts',
      ],
    },
  },
});
