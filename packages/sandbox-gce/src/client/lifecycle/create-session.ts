import { randomBytes } from 'node:crypto';

import type { SandboxDescription } from '../../protocol/api.js';
import type {
  GceConnectionSettings,
  GceNetworkSandboxSessionCreateOptions,
  GceNetworkSandboxSessionResumeOptions,
  GcePrepareSettings,
} from '../gce-settings.js';

import { GceSandboxNotFoundError } from '../errors/gce-sandbox-not-found-error.js';
import { GceNetworkSandboxSession } from '../session/gce-network-sandbox-session.js';
import { identityToken } from '../transport/identity-token.js';
import { SandboxServiceClient } from '../transport/sandbox-service-client.js';
import { abortReason } from '../utils/abort.js';
import { assertRequiredCommands, DEFAULT_REQUIRED_COMMANDS } from './required-commands.js';
import { ensureTemplate, type ReadyTemplate, runSetup, templateId } from './sandbox-template.js';

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

/** What a sandbox is created with, but its template. */
type CreateOptions = Omit<Parameters<SandboxServiceClient['create']>[1], 'template'>;

/** Creates the sandbox `name`, from `template` when given, its builder removed once it runs. */
async function createFrom(
  client: SandboxServiceClient,
  name: string,
  { template, ...options }: CreateOptions & { template: ReadyTemplate | undefined },
): Promise<SandboxDescription> {
  try {
    return await client.create(name, { ...options, template: template?.id });
  } finally {
    // Not before: with no sandbox running in between, the service would stop the egress proxy.
    await template?.releaseBuilder();
  }
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
  const { abortSignal, template, setup = [], allowedHosts, baseUrls, image } = options;
  const requiredCommands = options.requiredCommands ?? DEFAULT_REQUIRED_COMMANDS;
  if (abortSignal?.aborted) throw abortReason(abortSignal);
  const name = options.sandboxId ?? `ai-sdk-${randomBytes(4).toString('hex')}`;
  assertSandboxName(name);
  const client = clientOf(options);
  const network = { allowedHosts, baseUrls };
  const ready = template
    ? await ensureTemplate(
        client,
        { template, setup, network, image, requiredCommands },
        abortSignal,
      )
    : undefined;
  const description = await createFrom(client, name, {
    ...network,
    image,
    template: ready,
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
 * Has the sandbox service at `url` boot what a sandbox needs, without waiting for it: its egress
 * proxy when the service starts and stops it, and, given the sandbox's `template` (with its `setup`
 * and `image`), a machine booted from it. Call it as soon as a sandbox is likely to be asked for,
 * the person who launches it still reading what will run, and the creation that follows finds them
 * up. A hint: do not await it, and ignore its errors, which change nothing for the sandboxes.
 *
 * It never builds the template: before the first sandbox made from it, only the proxy is booted.
 * Should no sandbox come, the proxy stops by itself, and the service deletes the machine as it
 * meets it, once it waited 15 minutes. A service of an earlier version boots the proxy only, or
 * nothing.
 */
export async function prepareGceSandboxService(options: GcePrepareSettings): Promise<void> {
  const { template, setup = [], image, abortSignal } = options;
  await clientOf(options).prepare({
    template: template === undefined ? undefined : templateId({ template, setup }),
    image,
    abortSignal,
  });
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
