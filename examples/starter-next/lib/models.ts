import type { HarnessId, OpenRouterModel } from '@/lib/harnesses';

import { usesOpenRouter } from '@/lib/harnesses';

/** OpenRouter's public catalog: no key needed to read it. */
const CATALOG_URL = 'https://openrouter.ai/api/v1/models';

/** How long a catalog read is kept before the next one: models come and go on OpenRouter. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

interface CatalogEntry {
  id: string;
  name: string;
  supported_parameters?: string[];
}

const globals = globalThis as {
  __aiSdkOpenRouterCatalog?: { models: Promise<OpenRouterModel[]>; readAt: number };
};

async function readCatalog(): Promise<OpenRouterModel[]> {
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status}.`);
  const { data } = (await response.json()) as { data: CatalogEntry[] };
  // A coding agent drives its tools through the model: those that cannot call tools are left out,
  // and so are the aliases that route to another model (`~anthropic/claude-sonnet-latest`) and the
  // batch variants, which answer later rather than in a conversation.
  return data
    .filter(
      ({ id, supported_parameters }) =>
        supported_parameters?.includes('tools') && !id.startsWith('~') && !id.endsWith(':batch'),
    )
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The models of OpenRouter that can call tools, read once an hour. When OpenRouter cannot be
 * reached, none: the harnesses that go through it offer their suggested models only.
 */
function openRouterModels(): Promise<OpenRouterModel[]> {
  const cached = globals.__aiSdkOpenRouterCatalog;
  if (cached !== undefined && Date.now() - cached.readAt < CATALOG_TTL_MS) return cached.models;
  const models = readCatalog().catch((error: unknown) => {
    process.emitWarning(`The catalog of OpenRouter could not be read: ${String(error)}`);
    // Read again at the next request rather than in an hour.
    globals.__aiSdkOpenRouterCatalog = undefined;
    return [];
  });
  globals.__aiSdkOpenRouterCatalog = { models, readAt: Date.now() };
  return models;
}

/**
 * The catalog of OpenRouter when one of `harnesses` goes through it, none otherwise: OpenRouter is
 * not called for an example that does not use it.
 */
export async function openRouterModelsFor(
  harnesses: readonly HarnessId[],
): Promise<OpenRouterModel[]> {
  return usesOpenRouter(harnesses) ? openRouterModels() : [];
}
