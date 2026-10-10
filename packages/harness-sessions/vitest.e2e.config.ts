import { vitestConfig } from '@repo/vitest-config';

// Runs real Claude Code turns in a Docker Sandbox: needs `sbx`, and the credential (or the CLI
// login) of Claude Code on this host.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
