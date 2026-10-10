import { randomBytes } from 'node:crypto';

import type {
  MicrosandboxNetworkSandboxSessionCreateOptions,
  MicrosandboxNetworkSandboxSessionResumeOptions,
} from '../microsandbox-settings.js';
import type { MicrosandboxNetworkSandboxSession } from '../session/microsandbox-network-sandbox-session.js';
import type { MicrosandboxConnection } from '../transport/microsandbox-connection.js';

import {
  connectSandbox,
  createSandbox,
  restoreSandbox,
  sandboxExists,
} from '../transport/microsandbox-runtime.js';
import { openSession, prepareSandbox } from './open-sandbox.js';
import { assertSandboxName, DEFAULT_IMAGE, sandboxSpec } from './sandbox-spec.js';
import { ensureTemplateSnapshot } from './sandbox-template.js';

/**
 * Creates a [microsandbox](https://microsandbox.dev), a microVM booted from an OCI image on this
 * host, and returns a network sandbox session on it, to hand to
 * `HarnessAgent.createSession({ sandboxSession })`.
 *
 * Creation never resumes: a sandbox already named `sandboxId` is a conflict. Persist the returned
 * session's `id` and reattach with {@link resumeMicrosandboxNetworkSandboxSession}.
 *
 * Pass `template: await agent.getSandboxTemplate()` to install the harness once: the first call
 * saves a prepared sandbox as a disk snapshot, and every later sandbox is restored from it.
 *
 * The sandbox runs detached, and the caller owns it: `stop()` keeps its disk for later,
 * `destroy()` removes it.
 */
export async function createMicrosandboxNetworkSandboxSession(
  options: MicrosandboxNetworkSandboxSessionCreateOptions = {},
): Promise<MicrosandboxNetworkSandboxSession> {
  options.abortSignal?.throwIfAborted();
  const name = options.sandboxId ?? `ai-sdk-${randomBytes(4).toString('hex')}`;
  assertSandboxName(name);
  await assertNameFree(name);
  const connection = await boot(name, options);
  try {
    return await openSession(connection, options);
  } catch (error) {
    await connection.destroy();
    throw error;
  }
}

/** Fails, before anything is created, when `name` is taken. */
async function assertNameFree(name: string): Promise<void> {
  if (await sandboxExists(name)) {
    throw new Error(
      `A microsandbox named "${name}" already exists. Reattach to it with ` +
        'resumeMicrosandboxNetworkSandboxSession({ sandboxId }), or remove it with `msb rm`.',
    );
  }
}

/** Creates the sandbox `name`, from the template's snapshot when there is one, and readies it. */
async function boot(
  name: string,
  options: MicrosandboxNetworkSandboxSessionCreateOptions,
): Promise<MicrosandboxConnection> {
  const { abortSignal, template, setup = [] } = options;
  const image = options.image ?? DEFAULT_IMAGE;
  const spec = await sandboxSpec(options);
  const { user } = spec;
  if (template) {
    const snapshot = await ensureTemplateSnapshot(
      { template, image, user, setup },
      spec,
      abortSignal,
    );
    abortSignal?.throwIfAborted();
    // The snapshot already holds the working directory and what `setup` installed.
    return restoreSandbox(name, snapshot, spec);
  }
  const connection = await createSandbox(name, image, spec);
  try {
    await prepareSandbox(connection, {
      user,
      workspaceMounted: spec.workspace !== undefined,
      setup,
      abortSignal,
    });
    return connection;
  } catch (error) {
    // Half-made, the sandbox would block a retry under the same id.
    await connection.destroy();
    throw error;
  }
}

/**
 * Reattaches to a microsandbox made by {@link createMicrosandboxNetworkSandboxSession}, from this
 * process or another one, starting it again if it was stopped. Never creates one: throws
 * `MicrosandboxSandboxNotFoundError` when no sandbox is named `sandboxId`.
 *
 * The ports are those the sandbox was created with, read back from microsandbox.
 */
export async function resumeMicrosandboxNetworkSandboxSession(
  options: MicrosandboxNetworkSandboxSessionResumeOptions,
): Promise<MicrosandboxNetworkSandboxSession> {
  options.abortSignal?.throwIfAborted();
  return openSession(connectSandbox(options.sandboxId), options);
}
