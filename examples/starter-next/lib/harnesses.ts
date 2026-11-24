/**
 * The coding agents the example can run, and the models each one offers. Shared by the page, which
 * lets you pick one, and the server, which builds them (`lib/harness-adapters.ts`) and only accepts
 * what is listed here.
 *
 * Three harnesses, one of each kind: Claude Code and Codex, on their subscriptions, run in the
 * sandbox behind a bridge; Pi, through OpenRouter (`OPENROUTER_API_KEY`), runs in this server, its
 * tools working in the sandbox. A harness whose credential is missing is shown, but cannot be
 * picked. The other official adapters plug in the same way: an entry here and its factory in
 * `lib/harness-adapters.ts`.
 */
export const HARNESSES = {
  'claude-code': {
    label: 'Claude Code',
    description: "Anthropic's coding agent, its CLI driven through a bridge in the sandbox.",
    route: 'Claude subscription',
    credentials: 'CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or the login of the claude CLI',
    /** Where the agent's own loop runs: in the sandbox behind a bridge, or in this server. */
    runsIn: 'sandbox',
    /** Whether it can ask before it edits a file or runs a command (`permissionMode`). */
    asksFirst: true,
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ],
  },
  codex: {
    label: 'Codex',
    description: "OpenAI's coding agent, its CLI driven through a bridge in the sandbox.",
    route: 'ChatGPT subscription',
    credentials: 'the login of the codex CLI (CODEX_HOME), or OPENAI_API_KEY',
    runsIn: 'sandbox',
    // Codex takes no approvals of its own tools: the harness runs it with `allow-all` only.
    asksFirst: false,
    // The models of a ChatGPT subscription: it refuses `gpt-5.5`, which an API key runs.
    models: [
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
  },
  pi: {
    label: 'Pi',
    description: 'A minimal coding agent, run by this server, its tools working in the sandbox.',
    route: 'OpenRouter',
    credentials: 'OPENROUTER_API_KEY',
    runsIn: 'server',
    asksFirst: true,
    // Pi's `openrouter` provider. Pi only runs the models of its own catalog, generated from
    // OpenRouter's: a model added since then is refused, with a message that says so.
    openRouter: { prefix: 'openrouter/' },
    models: [
      { id: 'openrouter/deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'openrouter/z-ai/glm-5.3', label: 'GLM 5.3' },
    ],
  },
} as const;

export type HarnessId = keyof typeof HARNESSES;

export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

/**
 * The harnesses installed in the template every sandbox starts from: Claude Code and Codex. Pi runs
 * in the server and installs nothing.
 */
export const TEMPLATE_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex'];

/**
 * Whether each harness has the credential it authenticates with, read by the server from its
 * environment: the page greys out the others.
 */
export type HarnessAvailability = Record<HarnessId, boolean>;

/** A model of OpenRouter's catalog that can call tools, as `lib/models.ts` reads it. */
export interface OpenRouterModel {
  /** `moonshotai/kimi-k3` */
  id: string;
  /** `MoonshotAI: Kimi K3` */
  name: string;
}

/** A model a conversation may pick, in a group of the model selector. */
export interface ModelOption {
  /** What the harness is given: `openrouter/moonshotai/kimi-k3` for OpenCode. */
  id: string;
  label: string;
}

/**
 * How a harness names a model of OpenRouter's catalog, for those that go through OpenRouter: the
 * prefix that picks their OpenRouter provider.
 */
interface OpenRouterRoute {
  prefix: string;
}

function openRouterOf(harness: HarnessId): OpenRouterRoute | undefined {
  const entry = HARNESSES[harness];
  return 'openRouter' in entry ? (entry.openRouter as OpenRouterRoute) : undefined;
}

/** `model` as a harness on `route` names it. */
const openRouterOptionOf = (
  { id, name }: OpenRouterModel,
  { prefix }: OpenRouterRoute,
): ModelOption => ({
  id: `${prefix}${id}`,
  label: name.split(': ').at(-1) ?? name,
});

/** Who makes `model`, as OpenRouter names it: `MoonshotAI` of `MoonshotAI: Kimi K3`. */
const providerOf = ({ id, name }: OpenRouterModel): string =>
  name.includes(': ') ? name.slice(0, name.indexOf(': ')) : id.slice(0, id.indexOf('/'));

/**
 * The models `harness` offers, in groups: the few the example suggests, then, for a harness that
 * goes through OpenRouter, every model of `catalog` it can run, by provider.
 */
export function modelGroupsOf(
  harness: HarnessId,
  catalog: readonly OpenRouterModel[],
): { label: string; models: ModelOption[] }[] {
  const suggested: ModelOption[] = [...HARNESSES[harness].models];
  const route = openRouterOf(harness);
  if (route === undefined) return [{ label: 'Suggested', models: suggested }];
  const byProvider = new Map<string, ModelOption[]>();
  for (const model of catalog) {
    const option = openRouterOptionOf(model, route);
    if (suggested.some(({ id }) => id === option.id)) continue;
    const provider = providerOf(model);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), option]);
  }
  return [
    { label: 'Suggested', models: suggested },
    ...[...byProvider]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, models]) => ({ label: `OpenRouter · ${provider}`, models })),
  ];
}

/**
 * How a conversation's model reads: its label when suggested, its name in `catalog` when the
 * harness takes it from OpenRouter's, its id otherwise.
 */
export function modelNameOf(
  harness: HarnessId,
  model: string,
  catalog: readonly OpenRouterModel[],
): string {
  const option = modelGroupsOf(harness, catalog)
    .flatMap(({ models }) => models)
    .find(({ id }) => id === model);
  return option?.label ?? modelLabelOf(harness, model);
}

/** How a conversation's model reads: its label when suggested, its OpenRouter id otherwise. */
export function modelLabelOf(harness: HarnessId, model: string): string {
  const suggested = HARNESSES[harness].models.find(({ id }) => id === model);
  if (suggested !== undefined) return suggested.label;
  const prefix = openRouterOf(harness)?.prefix ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** The model a conversation starts with: the first, and cheapest, of its harness. */
export const defaultModel = (harness: HarnessId): string => HARNESSES[harness].models[0].id;

/**
 * Whether `harness` and `model` name an agent the example offers: a suggested model, or one of
 * `catalog` the harness can run through OpenRouter.
 */
export function isKnown(
  harness: unknown,
  model: unknown,
  catalog: readonly OpenRouterModel[],
): harness is HarnessId {
  return (
    typeof harness === 'string' &&
    harness in HARNESSES &&
    modelGroupsOf(harness as HarnessId, catalog).some(({ models }) =>
      models.some(({ id }) => id === model),
    )
  );
}

/** Whether any harness goes through OpenRouter: the catalog is then worth reading. */
export const usesOpenRouter = (harnesses: readonly HarnessId[]): boolean =>
  harnesses.some((harness) => openRouterOf(harness) !== undefined);
