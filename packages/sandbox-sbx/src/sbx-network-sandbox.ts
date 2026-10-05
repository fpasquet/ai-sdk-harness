import { randomBytes } from 'node:crypto';

import type { SbxNetworkSandboxSession } from './sbx-network-sandbox-session.js';
import type {
  SbxNetworkSandboxSessionCreateOptions,
  SbxNetworkSandboxSessionResumeOptions,
} from './sbx-settings.js';

import { assertSandboxName, assertSettingsFit, createArgs } from './create-args.js';
import { assertSandboxExists, listSandboxes, openSandbox, runSetup } from './open-sandbox.js';
import { ensureTemplateImage } from './sandbox-template.js';
import { SbxCli } from './sbx-cli.js';

/** Fails, before anything is created, when `name` is taken. */
async function assertNameFree(cli: SbxCli, name: string, abortSignal?: AbortSignal): Promise<void> {
  if ((await listSandboxes(cli, abortSignal)).has(name)) {
    throw new Error(
      `A Docker Sandbox named "${name}" already exists. Reattach to it with ` +
        'resumeSbxNetworkSandboxSession({ sandboxId }), or remove it with `sbx rm`.',
    );
  }
}

/**
 * Creates a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/), a microVM run by the `sbx`
 * CLI on this host, or in Docker Sandboxes Cloud with `cloud: true`, and returns a network sandbox
 * session on it, to hand to `HarnessAgent.createSession({ sandboxSession })`.
 *
 * Creation never resumes: a sandbox already named `sandboxId` is a conflict. Persist the returned
 * session's `id` and reattach with {@link resumeSbxNetworkSandboxSession}.
 *
 * Pass `template: await agent.getSandboxTemplate()` to install the harness once: the first call
 * bakes a prepared sandbox into an image (`sbx template save`), in the local image store or in the
 * cloud registry, and every later sandbox starts from it.
 *
 * The caller owns the sandbox: `stop()` keeps its filesystem for later, `destroy()` removes it.
 */
export async function createSbxNetworkSandboxSession(
  options: SbxNetworkSandboxSessionCreateOptions = {},
): Promise<SbxNetworkSandboxSession> {
  const { abortSignal, template, setup = [] } = options;
  abortSignal?.throwIfAborted();
  const cloud = options.cloud ?? false;
  const name = options.sandboxId ?? `ai-sdk-${randomBytes(4).toString('hex')}`;
  assertSandboxName(name, cloud);
  assertSettingsFit(options, cloud);
  const cli = new SbxCli(options.binary, cloud);
  await assertNameFree(cli, name, abortSignal);

  const agent = options.agent ?? 'shell';
  const image = template
    ? await ensureTemplateImage(cli, { template, agent, image: options.image, setup }, abortSignal)
    : options.image;
  await cli.check(
    createArgs({ name, image, fromTemplate: template !== undefined, settings: options }),
    {
      abortSignal,
    },
  );
  try {
    // A template already ran them, before it was saved.
    if (!template) await runSetup(cli, name, { setup, abortSignal });
    return await openSandbox(cli, name, options);
  } catch (error) {
    // Half-made, the sandbox would block a retry under the same id.
    await cli.run(['rm', '--force', name]);
    throw error;
  }
}

/**
 * Reattaches to a Docker Sandbox made by {@link createSbxNetworkSandboxSession}, from this
 * process or another one, starting it again if it was stopped. Never creates one: throws
 * `SbxSandboxNotFoundError` when no sandbox is named `sandboxId`.
 *
 * Ports are not stored by `sbx` until published: pass the same `ports` the sandbox was created
 * with.
 */
export async function resumeSbxNetworkSandboxSession(
  options: SbxNetworkSandboxSessionResumeOptions,
): Promise<SbxNetworkSandboxSession> {
  options.abortSignal?.throwIfAborted();
  const cli = new SbxCli(options.binary, options.cloud ?? false);
  await assertSandboxExists(cli, options.sandboxId, options.abortSignal);
  return openSandbox(cli, options.sandboxId, options);
}
