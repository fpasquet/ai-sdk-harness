import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCline } from '@ai-sdk/harness-cline';
import { createCodex } from '@ai-sdk/harness-codex';
import { createCursor } from '@ai-sdk/harness-cursor';
import { createDeepAgents } from '@ai-sdk/harness-deepagents';
import { createFx } from '@ai-sdk/harness-fx';
import { createGitHubCopilot } from '@ai-sdk/harness-github-copilot';
import { createGrokBuild } from '@ai-sdk/harness-grok-build';
import { createOpenCode } from '@ai-sdk/harness-opencode';
import { createPi } from '@ai-sdk/harness-pi';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HarnessAvailability, HarnessId } from '@/lib/harnesses';

/** OpenRouter's OpenAI-compatible API, which most runtimes speak. */
const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/** OpenRouter's Anthropic-compatible API: the Anthropic client adds `/v1/messages`. */
const OPENROUTER_ANTHROPIC_API = 'https://openrouter.ai/api';

const isSet = (name: string): boolean => (process.env[name] ?? '') !== '';

const openRouterKey = (): string => process.env.OPENROUTER_API_KEY ?? '';

/**
 * The login of the `claude` CLI on this machine. On macOS it is kept in the keychain, which cannot
 * be read without a prompt: the CLI's settings file stands for it.
 */
const claudeLogin = (): boolean =>
  existsSync(
    join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json'),
  ) ||
  (process.platform === 'darwin' && existsSync(join(homedir(), '.claude.json')));

/** The login of the `codex` CLI on this machine, which Codex and fx run on. */
const codexLogin = (): boolean =>
  existsSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));

/**
 * Whether each harness has what it authenticates with. Read at each request, so a credential added
 * to `.env.local` shows once the server restarts, and a CLI login at once.
 */
export function harnessAvailability(): HarnessAvailability {
  const openRouter = isSet('OPENROUTER_API_KEY');
  return {
    'claude-code': isSet('CLAUDE_CODE_OAUTH_TOKEN') || isSet('ANTHROPIC_API_KEY') || claudeLogin(),
    codex: isSet('OPENAI_API_KEY') || isSet('CODEX_API_KEY') || codexLogin(),
    opencode: openRouter,
    pi: openRouter,
    cline: openRouter,
    deepagents: openRouter,
    'grok-build': openRouter,
    fx: codexLogin(),
    'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].some(isSet),
    cursor: isSet('CURSOR_API_KEY'),
  };
}

/**
 * How each harness is built and authenticated. A credential given in an `auth` record replaces the
 * environment for that harness: an ambient `AI_GATEWAY_API_KEY` never reroutes it. Only a
 * placeholder of it enters the sandbox; a proxy outside swaps the real value in on the way out.
 */
const FACTORIES: Record<HarnessId, () => HarnessAgentAdapter> = {
  // From `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription) or `ANTHROPIC_API_KEY`, else the
  // login of the `claude` CLI. Claude Code gives its task tools (`TaskCreate`, `TaskUpdate`) to
  // older models alone unless asked: the page shows the list the agent keeps with them.
  'claude-code': () => createClaudeCode({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } }),
  // From `OPENAI_API_KEY`, else the login of the `codex` CLI (a ChatGPT subscription).
  codex: () => createCodex(),
  // A model `openrouter/<id>` makes OpenCode declare its OpenRouter provider with the key and the
  // base URL of the `openai` route, which the proxy brokers to openrouter.ai.
  opencode: () =>
    createOpenCode({
      provider: 'openai',
      auth: { OPENAI_API_KEY: openRouterKey(), OPENAI_BASE_URL: OPENROUTER_API },
    }),
  // Pi's own `openrouter` provider reads `OPENROUTER_API_KEY`; Pi runs here, the key never
  // reaches the sandbox.
  pi: () => createPi({ auth: { OPENROUTER_API_KEY: openRouterKey() } }),
  // Cline's own `openrouter` provider; Cline runs here too.
  cline: () => createCline({ auth: 'direct', providerId: 'openrouter', apiKey: openRouterKey() }),
  // Deep Agents drives an Anthropic client: OpenRouter's Anthropic-compatible API.
  deepagents: () =>
    createDeepAgents({
      auth: { ANTHROPIC_API_KEY: openRouterKey(), ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_API },
    }),
  // Grok Build takes its API's base URLs from the environment: pointed at OpenRouter, with the
  // OpenRouter key as its xAI key.
  'grok-build': () =>
    createGrokBuild({
      auth: {
        XAI_API_KEY: openRouterKey(),
        GROK_XAI_API_BASE_URL: OPENROUTER_API,
        GROK_MODELS_BASE_URL: OPENROUTER_API,
      },
    }),
  // On the Codex subscription of this machine: `direct` tries subscriptions before AI Gateway.
  // fx reads that subscription from 1.0.70 on, built on a newer `@ai-sdk/provider-utils` than the
  // example's: its schemas carry the same runtime marker (`Symbol.for`), but not the same type.
  fx: () => createFx({ auth: 'direct' }) as unknown as HarnessAgentAdapter,
  // From `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`: a Copilot subscription.
  'github-copilot': () => createGitHubCopilot({ auth: 'direct' }),
  // From `CURSOR_API_KEY`; the model provider is the one of the Cursor account.
  cursor: () => createCursor(),
};

const adapters = new Map<HarnessId, HarnessAgentAdapter>();

/** The adapter of `harness`, built the first time a conversation asks for it. */
export function adapterOf(harness: HarnessId): HarnessAgentAdapter {
  let adapter = adapters.get(harness);
  if (adapter === undefined) {
    adapter = FACTORIES[harness]();
    adapters.set(harness, adapter);
  }
  return adapter;
}
