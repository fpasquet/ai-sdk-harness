import { vitestConfig } from '@repo/vitest-config';

// Runs real Claude Code and Codex turns in a Docker Sandbox: needs `sbx`, and the credentials (or the
// CLI logins) of both runtimes on this host.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
