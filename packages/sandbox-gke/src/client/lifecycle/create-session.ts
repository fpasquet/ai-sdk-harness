import { randomBytes } from 'node:crypto';

import type { SandboxDescription } from '../../protocol/api.js';
import type {
  GkeConnectionSettings,
  GkeNetworkSandboxSessionCreateOptions,
  GkeNetworkSandboxSessionResumeOptions,
} from '../gke-settings.js';

import { GkeSandboxNotFoundError } from '../errors/gke-sandbox-not-found-error.js';
import { GkeNetworkSandboxSession } from '../session/gke-network-sandbox-session.js';
import { identityToken } from '../transport/identity-token.js';
import { SandboxServiceClient } from '../transport/sandbox-service-client.js';
import { abortReason } from '../utils/abort.js';
import { assertRequiredCommands, DEFAULT_REQUIRED_COMMANDS } from './required-commands.js';
import { ensureTemplate, runSetup } from './sandbox-template.js';

/**
 * What a Kubernetes name takes once the service's prefix is put before it and its volume's after,
 * and a URL path as it is: never ending with a dash.
 */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/;

function assertSandboxName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid sandbox id "${name}": lowercase letters, digits and dashes, starting and ending with a letter or a digit, 54 at most.`,
    );
  }
}

function clientOf({
  url,
  auth = 'none',
  serviceToken,
}: GkeConnectionSettings): SandboxServiceClient {
  return new SandboxServiceClient(url, { token: identityToken(auth, url), serviceToken });
}

function sessionOf(
  client: SandboxServiceClient,
  { name, workingDirectory }: SandboxDescription,
  settings: GkeConnectionSettings,
): GkeNetworkSandboxSession {
  return new GkeNetworkSandboxSession(
    { client, name, workingDirectory, processes: new Set() },
    settings.ports ?? [],
  );
}

/**
 * Creates a sandbox, a pod of its own under [GKE Sandbox](https://cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods)
 * (gVisor), through the sandbox service at `url`, and returns a network sandbox session on it, to hand
 * to `HarnessAgent.createSession({ sandboxSession })`.
 *
 * Creation never resumes: a sandbox already named `sandboxId`, running or stopped, is a conflict.
 * Persist the returned session's `id` and reattach with {@link resumeGkeNetworkSandboxSession}.
 *
 * Pass `template: await agent.getSandboxTemplate()` to install the harness once: the first call
 * saves a prepared sandbox's home volume as a snapshot, and every later sandbox's volume starts
 * from it.
 *
 * The caller owns the sandbox: `stop()` deletes the pod and keeps its home volume, `destroy()`
 * deletes both.
 */
export async function createGkeNetworkSandboxSession(
  options: GkeNetworkSandboxSessionCreateOptions,
): Promise<GkeNetworkSandboxSession> {
  const { abortSignal, template, setup = [], allowedHosts, baseUrls, image } = options;
  const requiredCommands = options.requiredCommands ?? DEFAULT_REQUIRED_COMMANDS;
  if (abortSignal?.aborted) throw abortReason(abortSignal);
  const name = options.sandboxId ?? `ai-sdk-${randomBytes(4).toString('hex')}`;
  assertSandboxName(name);
  const client = clientOf(options);
  const network = { allowedHosts, baseUrls };
  const templateId = template
    ? await ensureTemplate(
        client,
        { template, setup, network, image, requiredCommands },
        abortSignal,
      )
    : undefined;
  const description = await client.create(name, {
    ...network,
    image,
    template: templateId,
    abortSignal,
  });
  const session = sessionOf(client, description, options);
  try {
    // A template was checked and set up before it was saved.
    if (!template) {
      await runSetup(session, setup, abortSignal);
      await assertRequiredCommands(session, requiredCommands, abortSignal);
    }
    return session;
  } catch (error) {
    // Half-made, the sandbox would block a retry under the same id.
    await client.remove(name).catch(() => undefined);
    throw error;
  }
}

/**
 * Reattaches to a sandbox made by {@link createGkeNetworkSandboxSession}, from this process or
 * another one: a running sandbox as it is, a stopped one's pod made again on its volume. Never creates
 * one: throws `GkeSandboxNotFoundError` when no sandbox is named `sandboxId`.
 *
 * The service does not keep what a sandbox may reach across a suspension: pass the same `ports`,
 * `allowedHosts` and `baseUrls` the sandbox was created with.
 */
export async function resumeGkeNetworkSandboxSession(
  options: GkeNetworkSandboxSessionResumeOptions,
): Promise<GkeNetworkSandboxSession> {
  const { abortSignal, sandboxId, allowedHosts, baseUrls } = options;
  if (abortSignal?.aborted) throw abortReason(abortSignal);
  assertSandboxName(sandboxId);
  const client = clientOf(options);
  const description = await client.resume(sandboxId, { allowedHosts, baseUrls, abortSignal });
  if (description === undefined) throw new GkeSandboxNotFoundError(sandboxId);
  return sessionOf(client, description, options);
}
