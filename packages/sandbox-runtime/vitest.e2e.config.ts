import { vitestConfig } from '@repo/vitest-config';

// Runs real sandboxes on this host, behind srt, and real Claude Code turns in one: needs what srt
// needs (see test/srt.ts), and the credential (or the CLI login) of Claude Code on this host.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
