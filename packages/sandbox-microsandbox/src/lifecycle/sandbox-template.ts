import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { createHash, randomBytes } from 'node:crypto';

import type { SandboxSpec } from '../transport/microsandbox-runtime.js';

import { MicrosandboxSandboxSession } from '../session/microsandbox-sandbox-session.js';
import { createSandbox, findSnapshot, snapshotSandbox } from '../transport/microsandbox-runtime.js';
import { WORKSPACE } from '../transport/sandbox-scripts.js';
import { prepareSandbox } from './open-sandbox.js';

/** The group templates are saved in, and the prefix of their names. */
export const TEMPLATE_GROUP = 'ai-sdk-harness-template';

/** What a template is built from: the harness's recipe, and the base it is laid on. */
export interface TemplateSource {
  template: HarnessV1SandboxTemplate;
  image: string;
  user?: string;
  setup: readonly string[];
}

/** Snapshots being built by this process, by name: one build per name at a time. */
const building = new Map<string, Promise<string>>();

/**
 * The snapshot of a sandbox prepared by `source.template`, built the first time and reused
 * afterwards: one sandbox is created, set up, prepared, stopped and saved as a disk snapshot, then
 * removed. Every later sandbox is restored from it, with the harness already installed.
 *
 * The name derives from the template's identity and from the base it is laid on, so a new harness
 * version or another image gets a snapshot of its own. `spec` sizes and fences the throwaway
 * sandbox, whose ports and mounts are left out.
 */
export function ensureTemplateSnapshot(
  source: TemplateSource,
  spec: SandboxSpec,
  abortSignal?: AbortSignal,
): Promise<string> {
  const name = templateName(source);
  let snapshot = building.get(name);
  if (snapshot === undefined) {
    snapshot = findSnapshot(name).then(
      (found) => found ?? buildSnapshot({ name, source, spec, abortSignal }),
    );
    building.set(name, snapshot);
    // A failed build is not remembered: the next sandbox tries again.
    snapshot.catch(() => building.delete(name));
  }
  return snapshot;
}

/** `ai-sdk-harness-template-<digest>`. */
export function templateName({ template, image, user, setup }: TemplateSource): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([1, template.identity, image, user ?? null, setup]))
    .digest('hex')
    .slice(0, 24);
  return `${TEMPLATE_GROUP}-${digest}`;
}

async function buildSnapshot({
  name,
  source: { template, image, user, setup },
  spec,
  abortSignal,
}: {
  name: string;
  source: TemplateSource;
  spec: SandboxSpec;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const builder = `${name}-${randomBytes(3).toString('hex')}`;
  const { cpus, memory, networkPolicy } = spec;
  const connection = await createSandbox(builder, image, {
    cpus,
    memory,
    user,
    ports: [],
    networkPolicy,
  });
  try {
    await prepareSandbox(connection, { user, workspaceMounted: false, setup, abortSignal });
    const session = new MicrosandboxSandboxSession({
      connection,
      workingDirectory: WORKSPACE,
      processes: new Set(),
    });
    await template.prepare({ session, abortSignal });
    abortSignal?.throwIfAborted();
    // A disk snapshot of a stopped sandbox: nothing half-written in it.
    await connection.stop();
    await snapshotSandbox(builder, name, TEMPLATE_GROUP);
    const reference = await findSnapshot(name);
    if (reference === undefined) throw new Error(`microsandbox did not save the snapshot ${name}.`);
    return reference;
  } finally {
    await connection.destroy();
  }
}
