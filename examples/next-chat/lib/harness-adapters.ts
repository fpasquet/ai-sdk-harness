import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createPi } from '@ai-sdk/harness-pi';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HarnessAvailability, HarnessId } from '@/lib/harnesses';

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

/** The login of the `codex` CLI on this machine, which Codex runs on. */
const codexLogin = (): boolean =>
  existsSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));

/**
 * Whether each harness has what it authenticates with. Read at each request, so a credential added
 * to `.env.local` shows once the server restarts, and a CLI login at once.
 */
export function harnessAvailability(): HarnessAvailability {
  return {
    'claude-code': isSet('CLAUDE_CODE_OAUTH_TOKEN') || isSet('ANTHROPIC_API_KEY') || claudeLogin(),
    codex: isSet('OPENAI_API_KEY') || isSet('CODEX_API_KEY') || codexLogin(),
    pi: isSet('OPENROUTER_API_KEY'),
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
  // Pi's own `openrouter` provider reads `OPENROUTER_API_KEY`; Pi runs here, the key never
  // reaches the sandbox.
  pi: () => createPi({ auth: { OPENROUTER_API_KEY: openRouterKey() } }),
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
