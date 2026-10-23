import { type ModelProvider, providerHosts, type ProviderLocation } from './provider-hosts.js';

/** What the runtime of a harness reaches from the sandbox. */
export interface HarnessNetwork {
  /** Where its runtime installs from, when the sandbox has no template yet. */
  install: readonly string[];
  /** Its own service, whatever model it runs: sign-in, agent API. */
  service: readonly string[];
  /** The providers its models come from unless told otherwise: see {@link providerHosts}. */
  providers: readonly ModelProvider[];
  /**
   * What a turn does without — telemetry, error reports, lists of models —: refused, the runtime
   * carries on. Its runtime's settings turn most of it off.
   */
  optional: readonly string[];
}

const NPM = ['registry.npmjs.org'];

/** Runs on your server, the sandbox its file system and shell only: it reaches nothing from it. */
const ON_YOUR_SERVER: HarnessNetwork = { install: [], service: [], providers: [], optional: [] };

/**
 * What each harness of `@ai-sdk/harness-*` reaches from the sandbox, by its `harnessId`. Read from
 * each adapter — the packages it installs, the hosts its credentials are brokered to — and from
 * the network documentation of each runtime. An ACP agent (`@ai-sdk/harness-acp`) has the id you
 * give it, and the hosts of the agent you install: list them yourself, beside the npm registry its
 * bridge installs from.
 */
export const HARNESS_NETWORK = {
  /** Claude Code: the Anthropic API; its telemetry and error reports go to Datadog. */
  'claude-code': {
    install: NPM,
    service: [],
    providers: ['anthropic'],
    optional: ['http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com'],
  },
  /** Codex: the OpenAI API with an API key, ChatGPT's with a ChatGPT sign-in. */
  codex: { install: NPM, service: [], providers: ['openai', 'chatgpt'], optional: [] },
  /** OpenCode: no provider of its own, so name one; its list of models comes from models.dev. */
  opencode: { install: NPM, service: [], providers: [], optional: ['models.dev'] },
  /** Deep Agents: Anthropic's API, or a gateway that speaks it. */
  deepagents: { install: NPM, service: [], providers: ['anthropic'], optional: [] },
  /** Cursor's agent: installed from cursor.com, its agent API on `*.cursor.sh`. */
  cursor: {
    install: ['cursor.com', 'downloads.cursor.com'],
    service: ['*.cursor.sh'],
    providers: [],
    optional: [],
  },
  /** GitHub Copilot: its API and GitHub's, which entitles the token. */
  'github-copilot': {
    install: NPM,
    service: ['github.com', 'api.github.com', 'api.githubcopilot.com', '*.githubcopilot.com'],
    providers: [],
    optional: [
      'collector.github.com',
      'copilot-telemetry.githubusercontent.com',
      'default.exp-tas.com',
    ],
  },
  /** Grok Build: the xAI API with an API key, Grok's proxy with a subscription. */
  'grok-build': {
    install: NPM,
    service: ['cli-chat-proxy.grok.com'],
    providers: ['xai'],
    optional: ['code.grok.com', 'assets.grok.com'],
  },
  cline: ON_YOUR_SERVER,
  pi: ON_YOUR_SERVER,
  fx: ON_YOUR_SERVER,
} as const satisfies Record<string, HarnessNetwork>;

/** A harness id {@link HARNESS_NETWORK} knows. */
export type KnownHarness = keyof typeof HARNESS_NETWORK;

/** Which of a harness's hosts {@link harnessHosts} gives. */
export interface HarnessHostsOptions extends ProviderLocation {
  /**
   * The provider its models come from, in place of its own (`HARNESS_NETWORK[id].providers`):
   * `'gateway'` for the Vercel AI Gateway, `'amazon-bedrock'` with a `region`…
   */
  provider?: ModelProvider;
  /** Its optional hosts too: telemetry, error reports, lists of models. @defaultValue `false` */
  optional?: boolean;
  /** Its install hosts, for a sandbox without a template yet. @defaultValue `true` */
  install?: boolean;
}

/**
 * The hosts the runtime of the harness `harnessId` (`harness.harnessId`) reaches from the
 * sandbox: where it installs, its own service, and the API of its models' provider — its own, or
 * `options.provider`. None for a harness this package does not know, whose hosts are yours to list.
 *
 * @throws {Error} for a provider whose location is missing or wrong (Bedrock without a region…).
 */
export function harnessHosts(harnessId: string, options: HarnessHostsOptions = {}): string[] {
  if (!Object.hasOwn(HARNESS_NETWORK, harnessId)) return [];
  const network: HarnessNetwork = HARNESS_NETWORK[harnessId as KnownHarness];
  const providers = options.provider === undefined ? network.providers : [options.provider];
  const hosts = [
    ...(options.install === false ? [] : network.install),
    ...network.service,
    ...providers.flatMap((provider) => providerHosts(provider, options)),
    ...(options.optional === true ? network.optional : []),
  ];
  return [...new Set(hosts)];
}
