import { vitestConfig } from '@repo/vitest-config';

// Runs against this host's Docker Engine: creates, then removes, containers and networks.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
