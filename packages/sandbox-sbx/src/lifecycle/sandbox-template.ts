import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { createHash, randomBytes } from 'node:crypto';

import type { SbxCreationSettings } from '../sbx-settings.js';
import type { SbxCli } from '../transport/sbx-cli.js';

import { blockedRequests } from '../network/blocked-requests.js';
import { applyNetworkPolicy } from '../network/network-policy.js';
import { createArgs } from './create-args.js';
import { openSandbox, runSetup } from './open-sandbox.js';
import { assertRequiredCommands } from './required-commands.js';

/** The name templates are saved under: an image repository locally, a template name prefix in the cloud. */
export const TEMPLATE_REPOSITORY = 'ai-sdk-harness-template';

/** Where `sbx template save` puts a local template: the sandbox runtime's own image store. */
const LOCAL_STORE = 'docker.io/library/';

/** What a template is built from: the harness's recipe, and the base it is laid on. */
export interface TemplateSource {
  template: HarnessV1SandboxTemplate;
  agent: string;
  image?: string;
  setup: readonly string[];
  /** Commands the image must have once set up: not part of the template's reference. */
  requiredCommands: readonly string[];
  /**
   * The network of the sandbox the template is for: its setup and the harness's install run under
   * it, as they would in that sandbox. Not part of the template's reference.
   */
  network: Pick<SbxCreationSettings, 'allowNetwork' | 'denyNetwork' | 'networkPolicy'>;
}

/** Images being built by this process, by reference: one build per reference at a time. */
const building = new Map<string, Promise<string>>();

/**
 * The image of a sandbox prepared by `source.template`, built the first time and reused afterwards:
 * one sandbox is created, set up, prepared and saved with `sbx template save`, then removed. Every
 * later sandbox starts from that image, with the harness already installed. A local template lives
 * in this host's image store, a cloud one in the cloud registry, where saving takes minutes.
 *
 * The reference derives from the template's identity and from the base it is laid on, so a new
 * harness version or another kit gets an image of its own.
 */
export async function ensureTemplateImage(
  cli: SbxCli,
  source: TemplateSource,
  abortSignal?: AbortSignal,
): Promise<string> {
  const reference = templateReference(source, cli.cloud);
  let image = building.get(reference);
  if (image === undefined) {
    image = imageExists(cli, reference, abortSignal).then((exists) =>
      exists ? reference : buildImage({ cli, source, reference, abortSignal }),
    );
    building.set(reference, image);
    // A failed build is not remembered: the next sandbox tries again.
    image.catch(() => building.delete(reference));
  }
  return image;
}

/**
 * The template's reference: `docker.io/library/ai-sdk-harness-template:<digest>` locally, the name
 * `ai-sdk-harness-template-<digest>` in the cloud.
 */
export function templateReference(
  { template, agent, image, setup }: Omit<TemplateSource, 'network' | 'requiredCommands'>,
  cloud = false,
): string {
  // 2: templates are built under the network of their sandbox. Those of 1 ran their setup with
  // the machine's whole network, and are built again.
  const digest = createHash('sha256')
    .update(JSON.stringify([2, template.identity, agent, image ?? null, setup]))
    .digest('hex')
    .slice(0, 24);
  return cloud
    ? `${TEMPLATE_REPOSITORY}-${digest}`
    : `${LOCAL_STORE}${TEMPLATE_REPOSITORY}:${digest}`;
}

/** Whether `needle` is one of the strings anywhere in `value`. */
function containsString(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value === needle;
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).some((item) => containsString(item, needle));
}

/** An image of `sbx template ls`. */
interface TemplateImage {
  repository: string;
  tag: string;
}

async function imageExists(
  cli: SbxCli,
  reference: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const listed = JSON.parse(
    await cli.check(['template', 'ls', '--json'], { abortSignal, retry: true }),
  ) as TemplateImage[] | { images?: TemplateImage[] };
  if (cli.cloud) return containsString(listed, reference);
  // `sbx` 0.48 lists the images themselves, earlier versions under `images`.
  const images = Array.isArray(listed) ? listed : (listed.images ?? []);
  return images.some(({ repository, tag }) => `${repository}:${tag}` === reference);
}

/**
 * `error`, with the hosts the network refused to the builder sandbox when there were some: the
 * likely reason its setup or the harness's install failed.
 */
async function withRefusedHosts(cli: SbxCli, builder: string, error: unknown): Promise<unknown> {
  // Only a local sandbox has a policy log.
  if (cli.cloud) return error;
  const refused = await blockedRequests(cli, builder).catch(() => []);
  if (refused.length === 0) return error;
  const hosts = [...new Set(refused.map(({ host }) => host))].join(', ');
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}\nThe template was built under the sandbox's network, which refused ${hosts}: ` +
      'allow what its setup and the harness install need in `networkPolicy`.',
    { cause: error },
  );
}

async function buildImage({
  cli,
  source: { template, agent, image, setup, requiredCommands, network },
  reference,
  abortSignal,
}: {
  cli: SbxCli;
  source: TemplateSource;
  reference: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const builder = `${TEMPLATE_REPOSITORY}-${reference.slice(-12)}-${randomBytes(3).toString('hex')}`;
  // The setup runs under the network of the sandbox the template is for, never the machine's whole
  // network: what that sandbox could not reach, its template does not reach either.
  await cli.check(
    createArgs({
      name: builder,
      image,
      fromTemplate: false,
      settings: { agent, cloud: cli.cloud, ...network },
    }),
    { abortSignal, unbounded: true },
  );
  try {
    if (network.networkPolicy) await applyNetworkPolicy(cli, builder, network.networkPolicy);
    await runSetup(cli, builder, { setup, abortSignal });
    await assertRequiredCommands(cli, builder, { commands: requiredCommands, abortSignal });
    const session = await openSandbox(cli, builder, { abortSignal });
    await template.prepare({ session: session.restricted(), abortSignal });
    // A local `sbx template save` refuses a running sandbox; a cloud one snapshots it running.
    if (!cli.cloud) await cli.check(['stop', builder], { abortSignal });
    await cli.check(['template', 'save', builder, reference.replace(LOCAL_STORE, '')], {
      abortSignal,
      unbounded: true,
    });
    return reference;
  } catch (error) {
    throw await withRefusedHosts(cli, builder, error);
  } finally {
    await cli.run(['rm', '--force', builder]);
  }
}
