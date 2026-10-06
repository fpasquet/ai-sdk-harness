import { randomBytes } from 'node:crypto';

import type {
  CloudRunConnectionSettings,
  CloudRunNetworkSandboxSessionCreateOptions,
  CloudRunNetworkSandboxSessionResumeOptions,
} from './cloud-run-settings.js';
import type { SandboxDescription } from './sandbox-service-client.js';

import { CloudRunNetworkSandboxSession } from './cloud-run-network-sandbox-session.js';
import { CloudRunSandboxNotFoundError } from './cloud-run-sandbox-not-found-error.js';
import { abortReason } from './cloud-run-sandbox-session.js';
import { identityToken } from './identity-token.js';
import { SandboxServiceClient } from './sandbox-service-client.js';
import { ensureTemplate, runSetup } from './sandbox-template.js';

/** What the sandbox CLI of Cloud Run and a URL path both take as a name. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function assertSandboxName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid sandbox id "${name}": lowercase letters, digits and dashes, starting with a letter or a digit, 63 at most.`,
    );
  }
}

function clientOf({
  url,
  auth = 'gcloud',
  serviceToken,
}: CloudRunConnectionSettings): SandboxServiceClient {
  return new SandboxServiceClient(url, { token: identityToken(auth, url), serviceToken });
}

function sessionOf(
  client: SandboxServiceClient,
  { name, workingDirectory }: SandboxDescription,
  settings: CloudRunConnectionSettings,
): CloudRunNetworkSandboxSession {
  return new CloudRunNetworkSandboxSession(
    { client, name, workingDirectory, processes: new Set() },
    settings.ports ?? [],
  );
}

/**
 * Creates a [Cloud Run sandbox](https://docs.cloud.google.com/run/docs/code-execution) through the
 * sandbox service at `url`, and returns a network sandbox session on it, to hand to
 * `HarnessAgent.createSession({ sandboxSession })`.
 *
 * Creation never resumes: a sandbox already named `sandboxId`, running or suspended, is a
 * conflict. Persist the returned session's `id` and reattach with
 * {@link resumeCloudRunNetworkSandboxSession}.
 *
 * Pass `template: await agent.getSandboxTemplate()` to install the harness once: the first call
 * saves a prepared sandbox to the service's snapshot store, and every later sandbox starts from it.
 *
 * The caller owns the sandbox: `stop()` suspends it to a snapshot, `destroy()` deletes it.
 */
export async function createCloudRunNetworkSandboxSession(
  options: CloudRunNetworkSandboxSessionCreateOptions,
): Promise<CloudRunNetworkSandboxSession> {
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
 * Reattaches to a Cloud Run sandbox made by {@link createCloudRunNetworkSandboxSession}, from this
 * process or another one: a running sandbox as it is, a suspended one brought back from its
 * snapshot. Never creates one: throws `CloudRunSandboxNotFoundError` when no sandbox is named
 * `sandboxId`.
 *
 * The service does not keep what a sandbox may reach across a suspension: pass the same `ports`,
 * `allowedHosts` and `baseUrls` the sandbox was created with.
 */
export async function resumeCloudRunNetworkSandboxSession(
  options: CloudRunNetworkSandboxSessionResumeOptions,
): Promise<CloudRunNetworkSandboxSession> {
  const { abortSignal, sandboxId, allowedHosts, baseUrls } = options;
  if (abortSignal?.aborted) throw abortReason(abortSignal);
  assertSandboxName(sandboxId);
  const client = clientOf(options);
  const description = await client.resume(sandboxId, { allowedHosts, baseUrls, abortSignal });
  if (description === undefined) throw new CloudRunSandboxNotFoundError(sandboxId);
  return sessionOf(client, description, options);
}
