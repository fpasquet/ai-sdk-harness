/**
 * The coding agents the example can run, and the models each one offers. Shared by the page, which
 * lets you pick one, and the server, which builds them (`lib/harness-adapters.ts`) and only accepts
 * what is listed here.
 *
 * Claude Code and Codex run on their subscriptions, and fx on the Codex one; the other open
 * runtimes go through OpenRouter (`OPENROUTER_API_KEY`); GitHub Copilot and Cursor through their
 * own accounts. A harness whose credential is missing is shown, but cannot be picked.
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
    /** Whether a suspended conversation picks up with what was said before. */
    resumes: true,
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
    resumes: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
  },
  opencode: {
    label: 'OpenCode',
    description: 'The open-source coding agent, its server driven through a bridge in the sandbox.',
    route: 'OpenRouter',
    credentials: 'OPENROUTER_API_KEY',
    runsIn: 'sandbox',
    asksFirst: true,
    resumes: true,
    // `openrouter/` picks OpenCode's OpenRouter provider; the rest is the OpenRouter model.
    models: [
      { id: 'openrouter/deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'openrouter/z-ai/glm-5.3', label: 'GLM 5.3' },
    ],
  },
  pi: {
    label: 'Pi',
    description: 'A minimal coding agent, run by this server, its tools working in the sandbox.',
    route: 'OpenRouter',
    credentials: 'OPENROUTER_API_KEY',
    runsIn: 'server',
    asksFirst: true,
    resumes: true,
    // Models of Pi's own catalog, under its `openrouter` provider.
    models: [
      { id: 'openrouter/deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'openrouter/z-ai/glm-5.3', label: 'GLM 5.3' },
    ],
  },
  cline: {
    label: 'Cline',
    description: 'The Cline agent runtime, run by this server, its tools working in the sandbox.',
    route: 'OpenRouter',
    credentials: 'OPENROUTER_API_KEY',
    runsIn: 'server',
    asksFirst: true,
    resumes: true,
    models: [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'z-ai/glm-5.3', label: 'GLM 5.3' },
    ],
  },
  deepagents: {
    label: 'Deep Agents',
    description: "LangChain's LangGraph agent, run through a bridge in the sandbox.",
    route: 'OpenRouter',
    credentials: 'OPENROUTER_API_KEY',
    runsIn: 'sandbox',
    // The adapter cannot yet answer approvals of its built-in tools.
    asksFirst: false,
    // Its conversation lives in the bridge's memory: a suspension forgets it, the files stay.
    resumes: false,
    // Deep Agents speaks the Anthropic API: OpenRouter's Anthropic-compatible endpoint.
    models: [
      { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'z-ai/glm-5.3', label: 'GLM 5.3' },
    ],
  },
  'grok-build': {
    label: 'Grok Build',
    description: "xAI's coding agent, its CLI driven over ACP in the sandbox.",
    route: 'OpenRouter',
    credentials: 'OPENROUTER_API_KEY',
    runsIn: 'sandbox',
    asksFirst: false,
    resumes: true,
    models: [
      { id: 'x-ai/grok-build-0.1', label: 'Grok Build 0.1' },
      { id: 'x-ai/grok-4.7', label: 'Grok 4.7' },
    ],
  },
  fx: {
    label: 'fx',
    description: 'The fx agent engine, run by this server, its tools working in the sandbox.',
    route: 'ChatGPT subscription',
    credentials: 'the login of the codex CLI (CODEX_HOME)',
    runsIn: 'server',
    asksFirst: true,
    resumes: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
  },
  'github-copilot': {
    label: 'GitHub Copilot',
    description: "GitHub's coding agent, its CLI driven over ACP in the sandbox.",
    route: 'Copilot subscription',
    credentials: 'COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN',
    runsIn: 'sandbox',
    asksFirst: false,
    resumes: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
    ],
  },
  cursor: {
    label: 'Cursor',
    description: "Cursor's agent, its CLI driven over ACP in the sandbox.",
    route: 'Cursor account',
    credentials: 'CURSOR_API_KEY',
    runsIn: 'sandbox',
    asksFirst: false,
    resumes: true,
    // Cursor routes the models itself, as its account settings say.
    models: [
      { id: 'auto', label: 'Auto' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ],
  },
} as const;

export type HarnessId = keyof typeof HARNESSES;

export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

/**
 * The harnesses installed in the template every sandbox starts from: Claude Code and Codex. The
 * others install themselves in the sandbox the first time a conversation runs them, or run in the
 * server (Pi, Cline, fx) and install nothing.
 */
export const TEMPLATE_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex'];

/**
 * Whether each harness has the credential it authenticates with, read by the server from its
 * environment: the page greys out the others.
 */
export type HarnessAvailability = Record<HarnessId, boolean>;

/** The model a conversation starts with: the first, and cheapest, of its harness. */
export const defaultModel = (harness: HarnessId): string => HARNESSES[harness].models[0].id;

/** Whether `harness` and `model` name an agent of the catalog. */
export function isKnown(harness: unknown, model: unknown): harness is HarnessId {
  return (
    typeof harness === 'string' &&
    harness in HARNESSES &&
    HARNESSES[harness as HarnessId].models.some(({ id }) => id === model)
  );
}
