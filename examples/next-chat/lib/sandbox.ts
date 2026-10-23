import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxTemplate } from '@ai-sdk/harness';
import type { CloudRunAuth } from 'ai-sdk-sandbox-cloud-run';
import type { SbxBlockedRequest, SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { allowedHosts, harnessHosts, trustedHosts } from 'ai-sdk-harness-network';
import {
  CloudRunSandboxNotFoundError,
  createCloudRunNetworkSandboxSession,
  resumeCloudRunNetworkSandboxSession,
} from 'ai-sdk-sandbox-cloud-run';
import {
  createMicrosandboxNetworkSandboxSession,
  resumeMicrosandboxNetworkSandboxSession,
} from 'ai-sdk-sandbox-microsandbox';
import {
  createSrtNetworkSandboxSession,
  resumeSrtNetworkSandboxSession,
  SrtSandboxNotFoundError,
} from 'ai-sdk-sandbox-runtime';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

import type { SandboxId } from '@/lib/sandboxes';

import { HARNESS_IDS } from '@/lib/harnesses';
import { sandboxIdOf } from '@/lib/sandboxes';

/** A setting of the example is missing or wrong: its message says which, and what to do. */
export class ExampleConfigurationError extends Error {
  override name = 'ExampleConfigurationError';
}

/** What the example needs of a sandbox, whichever package made it. */
export type ExampleSandbox = HarnessV1NetworkSandboxSession & {
  fork(options: { ports: readonly number[] }): HarnessV1NetworkSandboxSession & {
    release(): Promise<void>;
  };
  killAllProcesses(): Promise<void>;
};

/**
 * The sandbox the agents run in: `EXAMPLE_SANDBOX=microsandbox` for a microsandbox,
 * `cloud-run` for Cloud Run, `srt` for srt on this machine, a Docker Sandbox otherwise.
 */
export const SANDBOX: SandboxId = sandboxIdOf(process.env.EXAMPLE_SANDBOX);

/** The sandbox the example creates once, then finds again on every start. */
const SANDBOX_ID = process.env.EXAMPLE_SANDBOX_ID ?? 'ai-sdk-harness-example';

/**
 * How long a conversation may stay idle before it is suspended: 5 minutes on Cloud Run, where a
 * sandbox is billed while it runs, 15 minutes with a local Docker Sandbox.
 * `EXAMPLE_SUSPEND_AFTER_MS` overrides it, 0 never suspends.
 */
export const SUSPEND_AFTER_MS = Number(
  process.env.EXAMPLE_SUSPEND_AFTER_MS ?? (SANDBOX === 'cloud-run' ? 5 : 15) * 60_000,
);

/**
 * A port the sandbox is opened with. The conversations' bridges listen on ports of their own, in
 * views of the sandbox (`lib/sessions.ts`).
 */
const BRIDGE_PORT = 4000;

/** The bridges install their dependencies with pnpm, which the `shell` kit does not ship. */
const SBX_SETUP = ['npm install --global --silent pnpm@10'];

/** The `node` image ships Node.js and git, but not pnpm. */
const MICROSANDBOX_SETUP = ['npm install --global --silent pnpm@10'];

/**
 * Whether the microsandbox runs a Docker daemon, as a Docker Sandbox does: on unless
 * `EXAMPLE_MICROSANDBOX_DOCKER=false`. Read when the sandbox is created; a sandbox found again
 * keeps what it was created with.
 */
const MICROSANDBOX_DOCKER = process.env.EXAMPLE_MICROSANDBOX_DOCKER !== 'false';

/** The image of the Cloud Run service should ship pnpm; installed here when it does not. */
const CLOUD_RUN_SETUP = ['command -v pnpm >/dev/null || npm install --global --silent pnpm@10'];

const CLOUD_RUN_AUTH = ['gcloud', 'metadata', 'none'] as const;

/** What each coding agent is told of the sandbox it works in. */
export const SANDBOX_INSTRUCTIONS: Record<SandboxId, string> = {
  sbx:
    'You are a coding agent working in a Docker Sandbox: a Linux microVM with Node.js and git, ' +
    'isolated from the host. Feel free to create files and run commands to answer.',
  microsandbox:
    'You are a coding agent working in a microsandbox: a Linux microVM with Node.js, git and ' +
    `Python${MICROSANDBOX_DOCKER ? ', and Docker with docker compose' : ''}, isolated from the ` +
    'host. Feel free to create files and run commands to answer.' +
    (MICROSANDBOX_DOCKER
      ? ' HTTPS leaves the microVM through a proxy with a certificate authority of its own, which ' +
        'containers do not trust: for HTTPS from a container, mount ' +
        '/etc/ssl/certs/ca-certificates.crt read-only at the same path in it, and set ' +
        'NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and CURL_CA_BUNDLE to that path. Never turn TLS ' +
        'verification off.'
      : ''),
  'cloud-run':
    'You are a coding agent working in a Cloud Run sandbox: a Linux sandbox with Node.js and git, ' +
    'whose network only reaches the model API and the npm registry. Feel free to create files and ' +
    'run commands to answer.',
  srt:
    "You are a coding agent working in an srt sandbox on the user's machine: you may write in your " +
    "working directory, read the rest of the machine but the user's home, and reach the model APIs " +
    'and the npm registry only. Feel free to create files and run commands to answer.',
};

/** The template a new sandbox starts from, made only when one is created. */
type TemplateOf = () => Promise<HarnessV1SandboxTemplate | undefined>;

/**
 * Reattaches to the example's sandbox, or creates it from `template()`. A previous run of the
 * example may have left its bridges behind, holding their ports: whatever runs in a resumed sandbox
 * is stopped. `hosts` are what the sandbox reaches beside its harnesses: the hosts its checkouts are
 * fetched from (the workspace's `hosts()`), and those the marketplace's plugins reach from it. Its
 * network lets them through, with those of {@link exampleHosts}, and nothing else.
 */
export async function openSandbox(
  template: TemplateOf,
  hosts: readonly string[],
): Promise<ExampleSandbox> {
  if (SANDBOX === 'microsandbox') {
    throw new Error(
      'A microsandbox is opened per conversation: see createConversationMicrosandbox.',
    );
  }
  const sandbox = await OPENERS[SANDBOX](template, hosts);
  if (sandbox.resumed) await sandbox.session.killAllProcesses();
  return sandbox.session;
}

type Opened = { resumed: boolean; session: ExampleSandbox };

/**
 * What the example's sandboxes reach, and nothing else: the trusted hosts of the whole ecosystem,
 * where the agents clone and install, the hosts Claude Code and Codex install from and call, and
 * `hosts`.
 */
function exampleHosts(hosts: readonly string[]): string[] {
  return allowedHosts(trustedHosts(), ...HARNESS_IDS.map((id) => harnessHosts(id)), hosts);
}

/**
 * The Docker Sandbox the conversations share, once opened, and when: kept on globalThis so that
 * `next dev` reloading this module still finds it.
 */
const opened = globalThis as {
  __aiSdkSbxExample?: { session: SbxNetworkSandboxSession; at: Date };
};

/**
 * A Docker Sandbox on this machine, closed to all but {@link exampleHosts}: within the machine's
 * own policy, which keeps this host and its private networks out of reach whatever it lists.
 */
async function openSbx(template: TemplateOf, hosts: readonly string[]): Promise<Opened> {
  const settings = { sandboxId: SANDBOX_ID, ports: [BRIDGE_PORT], binary: process.env.SBX_BIN };
  const networkPolicy = { mode: 'custom', allowedHosts: exampleHosts(hosts) } as const;
  let session: SbxNetworkSandboxSession | undefined;
  try {
    session = await resumeSbxNetworkSandboxSession(settings);
    // Set again on every resume: an edit of the marketplace reaches the sandbox found again.
    await session.setNetworkPolicy?.(networkPolicy);
  } catch (error) {
    if (!(error instanceof SbxSandboxNotFoundError)) throw error;
  }
  const resumed = session !== undefined;
  session ??= await createSbxNetworkSandboxSession({
    ...settings,
    networkPolicy,
    setup: SBX_SETUP,
    template: await template(),
  });
  opened.__aiSdkSbxExample = { session, at: new Date() };
  return { resumed, session };
}

/**
 * The hosts the Docker Sandboxes proxy refused to the shared sandbox since the example opened it:
 * what its network policy, {@link exampleHosts}, does not allow. Undefined until a conversation
 * opened a local Docker Sandbox; the other sandboxes do not report them.
 */
export async function blockedHosts(): Promise<
  undefined | { sandboxId: string; blocked: SbxBlockedRequest[] }
> {
  const sbx = opened.__aiSdkSbxExample;
  if (SANDBOX !== 'sbx' || sbx?.session.blockedRequests === undefined) return undefined;
  return {
    sandboxId: sbx.session.id,
    blocked: await sbx.session.blockedRequests({ since: sbx.at }),
  };
}

/**
 * How many conversations may be live at once with `EXAMPLE_SANDBOX=microsandbox`, each in a microVM
 * of its own; a suspended one holds none.
 */
export const MICROSANDBOX_CONVERSATIONS = 4;

/** The microVM of one conversation: `ai-sdk-harness-example-<conversation id>`. */
const conversationSandboxId = (conversationId: string): string => `${SANDBOX_ID}-${conversationId}`;

/**
 * With `EXAMPLE_SANDBOX=microsandbox`, each conversation gets a microVM of its own rather than a
 * view of a shared one: a new credential restarts a microsandbox, which would end the turns of the
 * other conversations. The first one installs both harnesses and saves the template; every later
 * microVM is restored from it in about a second.
 */
export async function createConversationMicrosandbox(
  conversationId: string,
  template: TemplateOf,
  abortSignal?: AbortSignal,
): Promise<HarnessV1NetworkSandboxSession> {
  return createMicrosandboxNetworkSandboxSession({
    sandboxId: conversationSandboxId(conversationId),
    ports: [BRIDGE_PORT],
    setup: MICROSANDBOX_SETUP,
    docker: MICROSANDBOX_DOCKER,
    template: await template(),
    abortSignal,
  });
}

/** The microVM of a conversation, started again when its conversation was suspended. */
export function resumeConversationMicrosandbox(
  conversationId: string,
  abortSignal?: AbortSignal,
): Promise<HarnessV1NetworkSandboxSession> {
  return resumeMicrosandboxNetworkSandboxSession({
    sandboxId: conversationSandboxId(conversationId),
    abortSignal,
  });
}

/**
 * A Cloud Run sandbox, through the sandbox service at `CLOUD_RUN_SANDBOX_URL`, called as the gcloud
 * account unless `CLOUD_RUN_SANDBOX_AUTH` says otherwise. Its network only reaches
 * {@link exampleHosts}, on top of the service's own.
 */
async function openCloudRun(template: TemplateOf, hosts: readonly string[]): Promise<Opened> {
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
    // The service does not keep them while the sandbox is suspended: a resume passes them again.
    allowedHosts: exampleHosts(hosts),
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

/**
 * A sandbox on this machine, behind srt. It needs `bwrap`, `socat` and `rg` on Linux (`rg` on
 * macOS): `SRT_SOCAT` and `SRT_RIPGREP` name binaries off the `PATH`, `SRT_ALLOW_ALL_UNIX_SOCKETS=1`
 * runs without srt's seccomp filter where Ubuntu refuses it (see the README of the package). Its
 * network reaches {@link exampleHosts} only.
 */
async function openSrt(template: TemplateOf, hosts: readonly string[]): Promise<Opened> {
  const settings = {
    sandboxId: SANDBOX_ID,
    ports: [BRIDGE_PORT],
    allowedDomains: exampleHosts(hosts),
    runtime: {
      socatPath: process.env.SRT_SOCAT,
      ripgrepPath: process.env.SRT_RIPGREP,
      allowAllUnixSockets: process.env.SRT_ALLOW_ALL_UNIX_SOCKETS === '1',
    },
  };
  try {
    return { resumed: true, session: await resumeSrtNetworkSandboxSession(settings) };
  } catch (error) {
    if (!(error instanceof SrtSandboxNotFoundError)) throw error;
  }
  const session = await createSrtNetworkSandboxSession({ ...settings, template: await template() });
  return { resumed: false, session };
}

/** How each sandbox shared between the conversations opens; a microsandbox is one per conversation. */
const OPENERS: Record<
  Exclude<SandboxId, 'microsandbox'>,
  (template: TemplateOf, hosts: readonly string[]) => Promise<Opened>
> = {
  sbx: openSbx,
  'cloud-run': openCloudRun,
  srt: openSrt,
};
