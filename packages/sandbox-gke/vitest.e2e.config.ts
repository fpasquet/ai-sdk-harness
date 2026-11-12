import { vitestConfig } from '@repo/vitest-config';

// Runs against a sandbox service deployed on Google Cloud (GKE_SANDBOX_URL): creates, stops,
// resumes and deletes real machines, and saves a template as an image.
export default vitestConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
