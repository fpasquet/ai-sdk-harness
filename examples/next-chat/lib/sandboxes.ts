/**
 * The sandboxes the example can run its coding agents in, picked by `EXAMPLE_SANDBOX`. Shared by the
 * page, which says where the agent runs, and the server, which opens the sandbox.
 */
export const SANDBOXES = {
  sbx: {
    label: 'Docker Sandbox',
    packageName: 'ai-sdk-sandbox-sbx',
    where: 'a Docker Sandbox microVM, not on your machine',
    description: 'running in a local microVM',
  },
  'cloud-run': {
    label: 'Cloud Run sandbox',
    packageName: 'ai-sdk-sandbox-cloud-run',
    where: 'a Cloud Run sandbox on Google Cloud',
    description: 'running in a Cloud Run sandbox on Google Cloud',
  },
} as const;

export type SandboxId = keyof typeof SANDBOXES;

/** The sandbox `EXAMPLE_SANDBOX` names: a Docker Sandbox when it is unset. */
export function sandboxIdOf(value: string | undefined): SandboxId {
  if (value === undefined || value === '') return 'sbx';
  if (value in SANDBOXES) return value as SandboxId;
  throw new Error(
    `EXAMPLE_SANDBOX=${value} is not a sandbox of the example: use ${Object.keys(SANDBOXES).join(' or ')}.`,
  );
}
