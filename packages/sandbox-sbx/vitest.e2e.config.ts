import { vitestConfig } from '@repo/vitest-config';

// Runs against the real `sbx` CLI: creates, snapshots and removes Docker Sandboxes on this host.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
