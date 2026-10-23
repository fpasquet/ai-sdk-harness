import { vitestConfig } from '@repo/vitest-config';

// Runs real Claude Code and Codex turns in Docker Sandboxes closed to all but the package's hosts:
// needs `sbx`, and the credential (or the CLI login) of each runtime on this host.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
