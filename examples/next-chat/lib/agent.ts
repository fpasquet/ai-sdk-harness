import type { HarnessAgentResumeSessionState, HarnessAgentSession } from '@ai-sdk/harness/agent';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';

import type { HarnessId } from '@/lib/harnesses';
import type { ExampleSandbox } from '@/lib/sandbox';

import { openSandbox, SANDBOX, SANDBOX_INSTRUCTIONS, SUSPEND_AFTER_MS } from '@/lib/sandbox';

/**
 * The two harnesses, each authenticated from the environment: Claude Code from
 * `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, Codex from `OPENAI_API_KEY`. Without them,
 * each falls back to the login of its own CLI on this machine, when it finds one.
 */
const HARNESS_ADAPTERS = {
  'claude-code': createClaudeCode(),
  codex: createCodex(),
};

interface ExampleState {
  /** One agent per harness and model, built the first time a conversation asks for it. */
  agents: Map<string, HarnessAgent>;
  /** The one sandbox of this process. */
  sandbox?: Promise<ExampleSandbox>;
  /** The conversation being held, one at a time since the bridge has one port. */
  chat?: { id: string; session: Promise<HarnessAgentSession> };
  /** The conversation suspended while idle, and what its agent needs to pick it up again. */
  suspended?: { id: string; resumeFrom: HarnessAgentResumeSessionState };
  /** The suspension under way, which a new message waits for. */
  suspending?: Promise<void>;
  /** Fires once the conversation has been idle for {@link SUSPEND_AFTER_MS}. */
  idleTimer?: NodeJS.Timeout;
}

// Kept on globalThis so `next dev` reloading this module does not open a second sandbox.
const globals = globalThis as { __aiSdkSbxExample?: ExampleState };
const state: ExampleState = (globals.__aiSdkSbxExample ??= { agents: new Map() });

/** The agent running `harness` on `model`. */
export function agentFor(harness: HarnessId, model: string): HarnessAgent {
  const key = `${harness}:${model}`;
  let agent = state.agents.get(key);
  if (agent === undefined) {
    agent = new HarnessAgent({
      id: `example-${harness}`,
      harness: HARNESS_ADAPTERS[harness],
      model,
      instructions: SANDBOX_INSTRUCTIONS[SANDBOX],
    });
    state.agents.set(key, agent);
  }
  return agent;
}

/**
 * Reattaches to the example's sandbox, a Docker Sandbox, a microsandbox or a Cloud Run sandbox
 * (`EXAMPLE_SANDBOX`), or creates it. The first creation installs both Claude Code and Codex in it,
 * then saves it as a template (a few minutes); every later one starts from that template in seconds.
 */
function createSandbox(): Promise<ExampleSandbox> {
  return openSandbox(() =>
    createHarnessSandboxTemplate({ harnesses: Object.values(HARNESS_ADAPTERS) }),
  );
}

function sandbox(): Promise<ExampleSandbox> {
  if (state.sandbox === undefined) {
    const opening = createSandbox();
    state.sandbox = opening;
    // A failure to open is not remembered: the next message tries again.
    opening.catch(() => {
      if (state.sandbox === opening) state.sandbox = undefined;
    });
  }
  return state.sandbox;
}

/**
 * The harness session of conversation `chatId`, run by `agent`. A new conversation ends the
 * previous one: its bridge stops, the sandbox stays. A conversation suspended while idle picks up
 * where it was, in its sandbox brought back from its snapshot.
 */
export function sessionFor(chatId: string, agent: HarnessAgent): Promise<HarnessAgentSession> {
  clearTimeout(state.idleTimer);
  if (state.suspending === undefined && state.chat?.id === chatId) return state.chat.session;
  const previous = state.chat?.session;
  const suspending = state.suspending;
  const session = (async () => {
    await suspending;
    await (await previous?.catch(() => undefined))?.destroy();
    const suspended = state.suspended?.id === chatId ? state.suspended : undefined;
    state.suspended = undefined;
    return agent.createSession({
      sessionId: chatId,
      sandboxSession: await sandbox(),
      resumeFrom: suspended?.resumeFrom,
    });
  })();
  state.chat = { id: chatId, session };
  session.catch(() => {
    if (state.chat?.session === session) state.chat = undefined;
  });
  return session;
}

/**
 * Suspends the conversation once it has been idle for {@link SUSPEND_AFTER_MS}: the agent's
 * session is stopped, its state kept, and the sandbox suspended. On Cloud Run, a sandbox is billed
 * as long as its bridge stays connected; suspended, it costs its snapshot's storage alone.
 */
export function idle(chatId: string): void {
  clearTimeout(state.idleTimer);
  if (SUSPEND_AFTER_MS <= 0) return;
  state.idleTimer = setTimeout(() => {
    if (state.chat?.id !== chatId || state.suspending !== undefined) return;
    const { session } = state.chat;
    const opened = state.sandbox;
    state.chat = undefined;
    state.sandbox = undefined;
    state.suspending = (async () => {
      const resumeFrom = await (await session).stop();
      state.suspended = { id: chatId, resumeFrom };
      await (await opened)?.stop();
    })()
      .catch(() => undefined)
      .finally(() => (state.suspending = undefined));
  }, SUSPEND_AFTER_MS);
  state.idleTimer.unref();
}
