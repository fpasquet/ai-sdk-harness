/**
 * The host of each model provider's API, by the name of its AI SDK provider package
 * (`@ai-sdk/<provider>`): the default `baseURL` of that package, or of the provider's own docs
 * when it has none. A provider whose host depends on a region or a resource is in
 * {@link providerHosts} only.
 */
export const PROVIDER_HOSTS = {
  alibaba: ['dashscope-intl.aliyuncs.com'],
  anthropic: ['api.anthropic.com'],
  baseten: ['inference.baseten.co'],
  bytedance: ['ark.ap-southeast.bytepluses.com'],
  cerebras: ['api.cerebras.ai'],
  cohere: ['api.cohere.com'],
  deepinfra: ['api.deepinfra.com'],
  deepseek: ['api.deepseek.com'],
  fireworks: ['api.fireworks.ai'],
  /** Vercel AI Gateway. */
  gateway: ['ai-gateway.vercel.sh'],
  /** GitHub Copilot's model API, which OpenCode can route to. */
  'github-copilot': ['api.githubcopilot.com'],
  gmicloud: ['api.gmi-serving.com'],
  /** The Gemini API of Google AI Studio. */
  google: ['generativelanguage.googleapis.com'],
  groq: ['api.groq.com'],
  huggingface: ['router.huggingface.co'],
  minimax: ['api.minimax.io'],
  mistral: ['api.mistral.ai'],
  moonshotai: ['api.moonshot.ai'],
  /** Ollama's cloud models; a local Ollama is a host of your own network. */
  ollama: ['ollama.com'],
  /** The OpenAI API, with an API key; a ChatGPT sign-in is `chatgpt`. */
  openai: ['api.openai.com'],
  /** The ChatGPT subscription Codex and OpenCode sign in with. */
  chatgpt: ['chatgpt.com'],
  openrouter: ['openrouter.ai'],
  perplexity: ['api.perplexity.ai'],
  togetherai: ['api.together.xyz'],
  xai: ['api.x.ai'],
  zai: ['api.z.ai'],
} as const satisfies Record<string, readonly string[]>;

/** A provider of {@link PROVIDER_HOSTS}, whose host is the same for everyone. */
export type FixedProvider = keyof typeof PROVIDER_HOSTS;

/** A provider whose host depends on where its models run: a region, or a resource of yours. */
export type RegionalProvider = 'amazon-bedrock' | 'azure' | 'google-vertex';

/** A provider {@link providerHosts} knows. */
export type ModelProvider = FixedProvider | RegionalProvider;

/** Where the models of a {@link RegionalProvider} run. */
export interface ProviderLocation {
  /**
   * `google-vertex`: a region (`us-central1`), or `global`, `us`, `eu` for the global and
   * multi-region endpoints; `global` when absent. `amazon-bedrock`: a region (`us-east-1`), required.
   */
  region?: string;
  /**
   * `azure`: the name of your Azure OpenAI or AI Foundry resource; any resource
   * (`*.openai.azure.com`, `*.services.ai.azure.com`) when absent.
   */
  resource?: string;
}

/** A label of a region or a resource name: letters, digits and inner `-`. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function labelOf(value: string, what: string): string {
  if (!LABEL.test(value)) throw new Error(`${what} "${value}" is not a name a host can carry.`);
  return value.toLowerCase();
}

/** The hosts of Vertex AI where `region` runs, and of the token a service account exchanges. */
function vertexHosts(region = 'global'): string[] {
  const location = labelOf(region, 'The Vertex AI region');
  const api =
    location === 'global'
      ? 'aiplatform.googleapis.com'
      : location === 'us' || location === 'eu'
        ? `aiplatform.${location}.rep.googleapis.com`
        : `${location}-aiplatform.googleapis.com`;
  return [api, 'oauth2.googleapis.com'];
}

/** The runtime of Amazon Bedrock in `region`, signed in place: no token host. */
function bedrockHosts(region: string | undefined): string[] {
  if (region === undefined) throw new Error('Amazon Bedrock needs the region of its models.');
  return [`bedrock-runtime.${labelOf(region, 'The Bedrock region')}.amazonaws.com`];
}

/** Azure OpenAI and AI Foundry, for one resource or any. */
function azureHosts(resource: string | undefined): string[] {
  const name = resource === undefined ? '*' : labelOf(resource, 'The Azure resource');
  return [`${name}.openai.azure.com`, `${name}.services.ai.azure.com`];
}

/**
 * The hosts the API of `provider` answers on — what a harness whose model it serves calls from
 * the sandbox. Vertex AI, Bedrock and Azure take where their models run (`location`); an unknown
 * provider gives none.
 *
 * @throws {Error} for Bedrock without a region, or a region or resource no host can carry.
 */
export function providerHosts(provider: string, location: ProviderLocation = {}): string[] {
  if (provider === 'google-vertex') return vertexHosts(location.region);
  if (provider === 'amazon-bedrock') return bedrockHosts(location.region);
  if (provider === 'azure') return azureHosts(location.resource);
  return Object.hasOwn(PROVIDER_HOSTS, provider)
    ? [...PROVIDER_HOSTS[provider as FixedProvider]]
    : [];
}
