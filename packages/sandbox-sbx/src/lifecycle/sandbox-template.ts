import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { createHash, randomBytes } from 'node:crypto';

import type { SbxCli } from '../transport/sbx-cli.js';

import { openSandbox, runSetup } from './open-sandbox.js';

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
  { template, agent, image, setup }: TemplateSource,
  cloud = false,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([1, template.identity, agent, image ?? null, setup]))
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

async function imageExists(
  cli: SbxCli,
  reference: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const listed = JSON.parse(await cli.check(['template', 'ls', '--json'], { abortSignal })) as {
    images?: { repository: string; tag: string }[];
  };
  if (cli.cloud) return containsString(listed, reference);
  return (listed.images ?? []).some(({ repository, tag }) => `${repository}:${tag}` === reference);
}

async function buildImage({
  cli,
  source: { template, agent, image, setup },
  reference,
  abortSignal,
}: {
  cli: SbxCli;
  source: TemplateSource;
  reference: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const builder = `${TEMPLATE_REPOSITORY}-${reference.slice(-12)}-${randomBytes(3).toString('hex')}`;
  await cli.check(
    ['create', '--name', builder, '--quiet', ...(image ? ['--template', image] : []), agent],
    { abortSignal },
  );
  try {
    await runSetup(cli, builder, { setup, abortSignal });
    const session = await openSandbox(cli, builder, { abortSignal });
    await template.prepare({ session: session.restricted(), abortSignal });
    // A local `sbx template save` refuses a running sandbox; a cloud one snapshots it running.
    if (!cli.cloud) await cli.check(['stop', builder], { abortSignal });
    await cli.check(['template', 'save', builder, reference.replace(LOCAL_STORE, '')], {
      abortSignal,
    });
    return reference;
  } finally {
    await cli.run(['rm', '--force', builder]);
  }
}
