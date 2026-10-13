import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { createHash, randomBytes } from 'node:crypto';

import type { SandboxSpec } from '../transport/microsandbox-runtime.js';

import { MicrosandboxSandboxSession } from '../session/microsandbox-sandbox-session.js';
import {
  createSandbox,
  findSnapshot,
  listSnapshots,
  removeSnapshot,
  snapshotSandbox,
} from '../transport/microsandbox-runtime.js';
import { WORKSPACE } from '../transport/sandbox-scripts.js';
import { prepareSandbox } from './open-sandbox.js';

/**
 * The prefix of the templates' names. They are saved in no snapshot group: microsandbox refuses
 * to remove the latest snapshot of a group, its head, while the group holds others.
 */
export const TEMPLATE_PREFIX = 'ai-sdk-harness-template';

/** What a template is built from: the harness's recipe, and the base it is laid on. */
export interface TemplateSource {
  template: HarnessV1SandboxTemplate;
  image: string;
  user?: string;
  setup: readonly string[];
  /** Docker Engine installed in it, and the size of its disk, which the snapshot carries. */
  docker?: { readonly diskSize: number };
}

/** Snapshots this process found or built, by name: one build per name at a time. */
const building = new Map<string, Promise<string>>();
/** The names of the snapshots this process is building right now. */
const inFlight = new Set<string>();

/**
 * The snapshot of a sandbox prepared by `source.template`, built the first time and reused
 * afterwards: one sandbox is created, set up, prepared, stopped and saved as a disk snapshot, then
 * removed. Every later sandbox is restored from it, with the harness already installed.
 *
 * The name derives from the template's identity and from the base it is laid on, so a new harness
 * version or another image gets a snapshot of its own. `spec` sizes and fences the throwaway
 * sandbox, whose ports and host mounts are left out. Its Docker disk is kept: the snapshot carries
 * it to every sandbox restored from it.
 */
export function ensureTemplateSnapshot(
  source: TemplateSource,
  spec: SandboxSpec,
  abortSignal?: AbortSignal,
): Promise<string> {
  const name = templateName(source);
  let snapshot = building.get(name);
  if (snapshot === undefined) {
    inFlight.add(name);
    snapshot = findSnapshot(name).then(
      (found) => found ?? buildSnapshot({ name, source, spec, abortSignal }),
    );
    building.set(name, snapshot);
    // A failed build is not remembered: the next sandbox tries again.
    snapshot.then(
      () => inFlight.delete(name),
      () => {
        inFlight.delete(name);
        building.delete(name);
      },
    );
  }
  return snapshot;
}

/** Options of {@link pruneMicrosandboxTemplates}. */
export interface PruneMicrosandboxTemplatesOptions {
  /**
   * Keep the templates made less than this many milliseconds ago.
   *
   * @defaultValue `0`: every template goes
   */
  olderThan?: number;
}

/**
 * Removes the template snapshots this package saved, and returns their names: a new harness
 * version, image or `setup` gets a template of its own, and leaves the previous one behind. The
 * sandboxes restored from a template are copies of their own, which neither stop nor lose
 * anything; the next sandbox created from a removed template builds it again. A template this
 * process is building is left alone.
 */
export async function pruneMicrosandboxTemplates({
  olderThan = 0,
}: PruneMicrosandboxTemplatesOptions = {}): Promise<string[]> {
  const before = Date.now() - olderThan;
  const stale = (await listSnapshots(`${TEMPLATE_PREFIX}-`)).filter(
    ({ name, createdAt }) => createdAt.getTime() <= before && !inFlight.has(name),
  );
  for (const { name, reference } of stale) {
    await removeSnapshot(reference);
    // The next sandbox builds it again rather than restoring what is gone.
    building.delete(name);
  }
  return stale.map(({ name }) => name);
}

/** `ai-sdk-harness-template-<digest>`. */
export function templateName({ template, image, user, setup, docker }: TemplateSource): string {
  // Without Docker, the digest is the one templates had before it.
  const base = [1, template.identity, image, user ?? null, setup];
  const digest = createHash('sha256')
    .update(JSON.stringify(docker === undefined ? base : [...base, 'docker', docker.diskSize]))
    .digest('hex')
    .slice(0, 24);
  return `${TEMPLATE_PREFIX}-${digest}`;
}

async function buildSnapshot({
  name,
  source: { template, image, user, setup, docker },
  spec,
  abortSignal,
}: {
  name: string;
  source: TemplateSource;
  spec: SandboxSpec;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const builder = `${name}-${randomBytes(3).toString('hex')}`;
  const { cpus, memory, networkPolicy, security, maxTcpConnections } = spec;
  const connection = await createSandbox(builder, image, {
    cpus,
    memory,
    user,
    ports: [],
    networkPolicy,
    security,
    maxTcpConnections,
    docker,
  });
  try {
    await prepareSandbox(connection, {
      user,
      workspaceMounted: false,
      docker: docker !== undefined,
      setup,
      abortSignal,
    });
    const session = new MicrosandboxSandboxSession({
      connection,
      workingDirectory: WORKSPACE,
      processes: new Set(),
    });
    await template.prepare({ session, abortSignal });
    abortSignal?.throwIfAborted();
    // A disk snapshot of a stopped sandbox: nothing half-written in it.
    await connection.stop();
    await snapshotSandbox(builder, name);
    const reference = await findSnapshot(name);
    if (reference === undefined) throw new Error(`microsandbox did not save the snapshot ${name}.`);
    return reference;
  } finally {
    await connection.destroy();
  }
}
