/**
 * The hosts each harness's runtime calls from the sandbox, by harness id, beside the npm registry
 * where it installs: the model API, and for Codex those of a ChatGPT sign-in, its API
 * (`chatgpt.com`) and the refresh of its token (`auth.openai.com`). `test/presets.e2e-spec.ts` runs
 * a turn of each in a Docker Sandbox closed to everything else.
 */
export const HARNESS_HOSTS = {
  'claude-code': ['api.anthropic.com'],
  codex: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
} as const satisfies Record<string, readonly string[]>;

/** A harness id {@link HARNESS_HOSTS} knows. */
export type KnownHarness = keyof typeof HARNESS_HOSTS;

/**
 * The hosts the runtime of the harness `harnessId` (`harness.harnessId`, `'claude-code'` or
 * `'codex'`) calls from the sandbox; none for a harness this package does not know, whose hosts
 * are yours to list.
 */
export function harnessHosts(harnessId: string): string[] {
  return Object.hasOwn(HARNESS_HOSTS, harnessId)
    ? [...HARNESS_HOSTS[harnessId as KnownHarness]]
    : [];
}
