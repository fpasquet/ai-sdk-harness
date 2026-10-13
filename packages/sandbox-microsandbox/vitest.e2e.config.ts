import { vitestConfig } from '@repo/vitest-config';

// Runs against the real microsandbox runtime: boots, snapshots and removes microVMs on this host.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
