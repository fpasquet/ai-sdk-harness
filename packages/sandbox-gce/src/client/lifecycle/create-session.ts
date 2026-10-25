import { randomBytes } from 'node:crypto';

import type { SandboxDescription } from '../../protocol/api.js';
import type {
  GceConnectionSettings,
  GceNetworkSandboxSessionCreateOptions,
  GceNetworkSandboxSessionResumeOptions,
} from '../gce-settings.js';

import { GceSandboxNotFoundError } from '../errors/gce-sandbox-not-found-error.js';
import { GceNetworkSandboxSession } from '../session/gce-network-sandbox-session.js';
import { identityToken } from '../transport/identity-token.js';
import { SandboxServiceClient } from '../transport/sandbox-service-client.js';
import { abortReason } from '../utils/abort.js';
import { ensureTemplate, runSetup } from './sandbox-template.js';

/**
 * What a Compute Engine instance name takes once the service's prefix is put before it, and a URL
 * path as it is: the instance name is at most 63 characters and never ends with a dash.
 */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/;

function assertSandboxName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid sandbox id "${name}": lowercase letters, digits and dashes, starting and ending with a letter or a digit, 55 at most.`,
    );
  }
}

function clientOf({
  url,
  auth = 'gcloud',
  serviceToken,
}: GceConnectionSettings): SandboxServiceClient {
  return new SandboxServiceClient(url, { token: identityToken(auth, url), serviceToken });
}

function sessionOf(
  client: SandboxServiceClient,
  { name, workingDirectory }: SandboxDescription,
  settings: GceConnectionSettings,
): GceNetworkSandboxSession {
  return new GceNetworkSandboxSession(
    { client, name, workingDirectory, processes: new Set() },
    settings.ports ?? [],
  );
}

/**
 * Creates a sandbox, a [Compute Engine](https://cloud.google.com/compute) virtual machine of its
 * own, through the sandbox service at `url`, and returns a network sandbox session on it, to hand
 * to `HarnessAgent.createSession({ sandboxSession })`.
 *
 * Creation never resumes: a sandbox already named `sandboxId`, running or stopped, is a conflict.
 * Persist the returned session's `id` and reattach with {@link resumeGceNetworkSandboxSession}.
 *
 * Pass `template: await agent.getSandboxTemplate()` to install the harness once: the first call
 * saves a prepared sandbox's disk as an image, and every later sandbox boots from it.
 *
 * The caller owns the sandbox: `stop()` stops the machine and keeps its disk, `destroy()` deletes
 * both.
 */
export async function createGceNetworkSandboxSession(
  options: GceNetworkSandboxSessionCreateOptions,
): Promise<GceNetworkSandboxSession> {
  const { abortSignal, template, setup = [], allowedHosts, baseUrls } = options;
  if (abortSignal?.aborted) throw abortReason(abortSignal);
  const name = options.sandboxId ?? `ai-sdk-${randomBytes(4).toString('hex')}`;
  assertSandboxName(name);
  const client = clientOf(options);
  const network = { allowedHosts, baseUrls };
  const templateId = template
    ? await ensureTemplate(client, { template, setup, network }, abortSignal)
    : undefined;
  const description = await client.create(name, { ...network, template: templateId, abortSignal });
  const session = sessionOf(client, description, options);
  try {
    // A template already ran them, before it was saved.
    if (!template) await runSetup(session, setup, abortSignal);
    return session;
  } catch (error) {
    // Half-made, the sandbox would block a retry under the same id.
    await client.remove(name).catch(() => undefined);
    throw error;
  }
}

/**
 * Reattaches to a sandbox made by {@link createGceNetworkSandboxSession}, from this process or
 * another one: a running sandbox as it is, a stopped one started again on its disk. Never creates
 * one: throws `GceSandboxNotFoundError` when no sandbox is named `sandboxId`.
 *
 * The service does not keep what a sandbox may reach across a suspension: pass the same `ports`,
 * `allowedHosts` and `baseUrls` the sandbox was created with.
 */
export async function resumeGceNetworkSandboxSession(
  options: GceNetworkSandboxSessionResumeOptions,
): Promise<GceNetworkSandboxSession> {
  const { abortSignal, sandboxId, allowedHosts, baseUrls } = options;
  if (abortSignal?.aborted) throw abortReason(abortSignal);
  assertSandboxName(sandboxId);
  const client = clientOf(options);
  const description = await client.resume(sandboxId, { allowedHosts, baseUrls, abortSignal });
  if (description === undefined) throw new GceSandboxNotFoundError(sandboxId);
  return sessionOf(client, description, options);
}
