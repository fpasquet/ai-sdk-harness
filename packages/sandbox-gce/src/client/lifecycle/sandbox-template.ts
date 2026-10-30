import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { createHash, randomBytes } from 'node:crypto';

import type { SandboxNetwork } from '../../protocol/api.js';
import type { SandboxServiceClient } from '../transport/sandbox-service-client.js';

import { GceNetworkSandboxSession } from '../session/gce-network-sandbox-session.js';
import { assertRequiredCommands } from './required-commands.js';

/** The prefix of the templates' ids, and of the sandboxes that build them. */
export const TEMPLATE_PREFIX = 'ai-sdk-harness-template';

/** What a template is built from: the harness's recipe, and the commands run before it. */
export interface TemplateSource {
  template: HarnessV1SandboxTemplate;
  setup: readonly string[];
}

/** Where a template is built: the image of its machine, and what it may reach meanwhile. */
interface BuildSettings {
  network: SandboxNetwork;
  /** The service's name of the image: its default without. */
  image?: string;
  /** Commands the image must have, checked before the setup. */
  requiredCommands: readonly string[];
}

/** A template ready to boot from, and the builder it was made with, if this process made it. */
export interface ReadyTemplate {
  id: string;
  /**
   * Removes the builder, once for all the sandboxes waiting for the template: after the first of
   * them is created, so that a sandbox always runs meanwhile and the service keeps its egress proxy
   * up. Never fails.
   */
  releaseBuilder(): Promise<void>;
}

/** Templates being built by this process, by service and id: one build at a time. */
const building = new Map<string, Promise<ReadyTemplate>>();

/**
 * The template's id: `ai-sdk-harness-template-<digest>`, the digest covering the harness's recipe
 * and the setup commands, so that a new harness version gets a template of its own.
 */
export function templateId({ template, setup }: TemplateSource): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([1, template.identity, setup]))
    .digest('hex')
    .slice(0, 24);
  return `${TEMPLATE_PREFIX}-${digest}`;
}

/** Runs each of `setup` in the sandbox, in order, stopping at the first failure. */
export async function runSetup(
  session: GceNetworkSandboxSession,
  setup: readonly string[],
  abortSignal?: AbortSignal,
): Promise<void> {
  for (const command of setup) {
    const { exitCode, stderr } = await session.run({ command, abortSignal });
    if (exitCode !== 0) {
      throw new Error(`Setup command \`${command}\` exited with ${exitCode}: ${stderr.trim()}`);
    }
  }
}

/**
 * The template prepared by `source.template`, built the first time and reused afterwards: one
 * sandbox is created, set up, prepared and its disk saved as an image by the service, then deleted
 * by {@link ReadyTemplate.releaseBuilder}. Every later sandbox boots from that image, the harness
 * already installed.
 */
export function ensureTemplate(
  client: SandboxServiceClient,
  source: BuildSettings & TemplateSource,
  abortSignal?: AbortSignal,
): Promise<ReadyTemplate> {
  const id = templateId(source);
  const key = `${client.baseUrl} ${source.image ?? ''} ${id}`;
  let ready = building.get(key);
  if (ready === undefined) {
    ready = client.templateExists(id, source.image, abortSignal).then(async (exists) => {
      let builder = exists ? undefined : await build(client, { ...source, id }, abortSignal);
      return {
        id,
        releaseBuilder: async () => {
          const name = builder;
          builder = undefined;
          if (name !== undefined) await client.remove(name).catch(() => undefined);
        },
      };
    });
    building.set(key, ready);
    // A failed build is not remembered: the next sandbox tries again.
    ready.catch(() => building.delete(key));
  }
  return ready;
}

async function build(
  client: SandboxServiceClient,
  {
    template,
    setup,
    network,
    image,
    requiredCommands,
    id,
  }: BuildSettings & TemplateSource & { id: string },
  abortSignal?: AbortSignal,
): Promise<string> {
  const builder = `${TEMPLATE_PREFIX}-${id.slice(-8)}-${randomBytes(3).toString('hex')}`;
  const { workingDirectory } = await client.create(builder, { ...network, image, abortSignal });
  // Answered once saved, for the caller to remove it; removed here when anything fails.
  try {
    const session = new GceNetworkSandboxSession(
      { client, name: builder, workingDirectory, processes: new Set() },
      [],
    );
    await runSetup(session, setup, abortSignal);
    await assertRequiredCommands(session, requiredCommands, abortSignal);
    await template.prepare({ session: session.restricted(), abortSignal });
    await client.saveTemplate(builder, id, { image, abortSignal });
    return builder;
  } catch (error) {
    await client.remove(builder).catch(() => undefined);
    throw error;
  }
}
