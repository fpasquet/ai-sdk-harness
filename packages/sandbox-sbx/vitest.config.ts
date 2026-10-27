import { vitestConfig } from '@repo/vitest-config';

export default vitestConfig({
  test: {
    // Every call of the fake `sbx` starts a process: a test of a few calls outlasts the default
    // 5 s on a CI runner busy with the suites of the other packages.
    testTimeout: 20_000,
  },
});
