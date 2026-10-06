import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxTemplate } from '@ai-sdk/harness';
import type { CloudRunAuth } from 'ai-sdk-sandbox-cloud-run';

import {
  CloudRunSandboxNotFoundError,
  createCloudRunNetworkSandboxSession,
  resumeCloudRunNetworkSandboxSession,
} from 'ai-sdk-sandbox-cloud-run';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

import type { SandboxId } from '@/lib/sandboxes';

import { sandboxIdOf } from '@/lib/sandboxes';

/** A setting of the example is missing or wrong: its message says which, and what to do. */
export class ExampleConfigurationError extends Error {
  override name = 'ExampleConfigurationError';
}

/** What the example needs of a sandbox, whichever package made it. */
export type ExampleSandbox = HarnessV1NetworkSandboxSession & {
  killAllProcesses(): Promise<void>;
};

/** The sandbox the agents run in: `EXAMPLE_SANDBOX=cloud-run` for Cloud Run, a Docker Sandbox otherwise. */
export const SANDBOX: SandboxId = sandboxIdOf(process.env.EXAMPLE_SANDBOX);

/** The sandbox the example creates once, then finds again on every start. */
const SANDBOX_ID = process.env.EXAMPLE_SANDBOX_ID ?? 'ai-sdk-harness-example';

/**
 * How long a conversation may stay idle before its sandbox is suspended: 5 minutes on Cloud Run,
 * where an idle sandbox is still billed while its bridge stays connected; never for a local Docker
 * Sandbox. `EXAMPLE_SUSPEND_AFTER_MS` overrides it, 0 never suspends.
 */
export const SUSPEND_AFTER_MS = Number(
  process.env.EXAMPLE_SUSPEND_AFTER_MS ?? (SANDBOX === 'cloud-run' ? 5 * 60_000 : 0),
);

/** Where the harness bridge listens inside the sandbox. */
const BRIDGE_PORT = 4000;

/** The bridges install their dependencies with pnpm, which the `shell` kit does not ship. */
const SBX_SETUP = ['npm install --global --silent pnpm@10'];

/** The image of the Cloud Run service should ship pnpm; installed here when it does not. */
const CLOUD_RUN_SETUP = ['command -v pnpm >/dev/null || npm install --global --silent pnpm@10'];

const CLOUD_RUN_AUTH = ['gcloud', 'metadata', 'none'] as const;

/** What each coding agent is told of the sandbox it works in. */
export const SANDBOX_INSTRUCTIONS: Record<SandboxId, string> = {
  sbx:
    'You are a coding agent working in a Docker Sandbox: a Linux microVM with Node.js and git, ' +
    'isolated from the host. Feel free to create files and run commands to answer.',
  'cloud-run':
    'You are a coding agent working in a Cloud Run sandbox: a Linux sandbox with Node.js and git, ' +
    'whose network only reaches the model API and the npm registry. Feel free to create files and ' +
    'run commands to answer.',
};

/** The template a new sandbox starts from, made only when one is created. */
type TemplateOf = () => Promise<HarnessV1SandboxTemplate | undefined>;

/**
 * Reattaches to the example's sandbox, or creates it from `template()`. A previous run of the example
 * may have left its bridge behind, holding the port: whatever runs in a resumed sandbox is stopped.
 */
export async function openSandbox(template: TemplateOf): Promise<ExampleSandbox> {
  const sandbox = await (SANDBOX === 'cloud-run' ? openCloudRun(template) : openSbx(template));
  if (sandbox.resumed) await sandbox.session.killAllProcesses();
  return sandbox.session;
}

type Opened = { resumed: boolean; session: ExampleSandbox };

async function openSbx(template: TemplateOf): Promise<Opened> {
  const settings = { sandboxId: SANDBOX_ID, ports: [BRIDGE_PORT], binary: process.env.SBX_BIN };
  try {
    return { resumed: true, session: await resumeSbxNetworkSandboxSession(settings) };
  } catch (error) {
    if (!(error instanceof SbxSandboxNotFoundError)) throw error;
  }
  const session = await createSbxNetworkSandboxSession({
    ...settings,
    setup: SBX_SETUP,
    template: await template(),
  });
  return { resumed: false, session };
}

/**
 * A Cloud Run sandbox, through the sandbox service at `CLOUD_RUN_SANDBOX_URL`, called as the gcloud
 * account unless `CLOUD_RUN_SANDBOX_AUTH` says otherwise. Its network only reaches the model APIs
 * and the npm registry, where the bridges install their dependencies.
 */
async function openCloudRun(template: TemplateOf): Promise<Opened> {
  const url = process.env.CLOUD_RUN_SANDBOX_URL;
  if (url === undefined || url === '') {
    throw new ExampleConfigurationError(
      'EXAMPLE_SANDBOX=cloud-run needs CLOUD_RUN_SANDBOX_URL, the URL of the sandbox service: see the README of ai-sdk-sandbox-cloud-run.',
    );
  }
  const auth = process.env.CLOUD_RUN_SANDBOX_AUTH ?? 'gcloud';
  if (!(CLOUD_RUN_AUTH as readonly string[]).includes(auth)) {
    throw new ExampleConfigurationError(
      `CLOUD_RUN_SANDBOX_AUTH=${auth}: use ${CLOUD_RUN_AUTH.join(', ')}.`,
    );
  }
  const settings = {
    url,
    auth: auth as CloudRunAuth,
    sandboxId: SANDBOX_ID,
    ports: [BRIDGE_PORT],
    allowedHosts: ['registry.npmjs.org'],
  };
  try {
    return { resumed: true, session: await resumeCloudRunNetworkSandboxSession(settings) };
  } catch (error) {
    if (!(error instanceof CloudRunSandboxNotFoundError)) throw error;
  }
  const session = await createCloudRunNetworkSandboxSession({
    ...settings,
    setup: CLOUD_RUN_SETUP,
    template: await template(),
  });
  return { resumed: false, session };
}
