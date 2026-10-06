import { vitestConfig } from '@repo/vitest-config';

// Runs against a sandbox service deployed on Cloud Run (CLOUD_RUN_SANDBOX_URL): creates, suspends,
// resumes and deletes real sandboxes, and saves a template to its bucket.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
