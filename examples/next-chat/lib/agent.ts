import type { HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

import type { HarnessId } from '@/lib/harnesses';

/** The Docker Sandbox the example creates once, then finds again on every start. */
const SANDBOX_ID = process.env.EXAMPLE_SANDBOX_ID ?? 'ai-sdk-harness-example';

/** Where the harness bridge listens inside the sandbox. */
const BRIDGE_PORT = 4000;

const INSTRUCTIONS =
  'You are a coding agent working in a Docker Sandbox: a Linux microVM with Node.js and git, ' +
  'isolated from the host. Feel free to create files and run commands to answer.';

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
  sandbox?: Promise<SbxNetworkSandboxSession>;
  /** The conversation being held, one at a time since the bridge has one port. */
  chat?: { id: string; session: Promise<HarnessAgentSession> };
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
      instructions: INSTRUCTIONS,
    });
    state.agents.set(key, agent);
  }
  return agent;
}

/**
 * Reattaches to the example's sandbox, or creates it. The first creation installs both Claude
 * Code and Codex in it, then saves it as a local template image (a few minutes); every later one
 * starts from that image in seconds.
 */
async function openSandbox(): Promise<SbxNetworkSandboxSession> {
  try {
    const sandbox = await resumeSbxNetworkSandboxSession({
      sandboxId: SANDBOX_ID,
      ports: [BRIDGE_PORT],
      binary: process.env.SBX_BIN,
    });
    // A previous run of the example may have left its bridge behind, holding the port.
    await sandbox.killAllProcesses();
    return sandbox;
  } catch (error) {
    if (!(error instanceof SbxSandboxNotFoundError)) throw error;
  }
  return createSbxNetworkSandboxSession({
    sandboxId: SANDBOX_ID,
    ports: [BRIDGE_PORT],
    binary: process.env.SBX_BIN,
    // The bridges install their dependencies with pnpm, which the `shell` kit does not ship.
    setup: ['npm install --global --silent pnpm@10'],
    template: await createHarnessSandboxTemplate({ harnesses: Object.values(HARNESS_ADAPTERS) }),
  });
}

function sandbox(): Promise<SbxNetworkSandboxSession> {
  if (state.sandbox === undefined) {
    const opening = openSandbox();
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
 * previous one: its bridge stops, the sandbox stays.
 */
export function sessionFor(chatId: string, agent: HarnessAgent): Promise<HarnessAgentSession> {
  if (state.chat?.id === chatId) return state.chat.session;
  const previous = state.chat?.session;
  const session = (async () => {
    await (await previous?.catch(() => undefined))?.destroy();
    return agent.createSession({ sessionId: chatId, sandboxSession: await sandbox() });
  })();
  state.chat = { id: chatId, session };
  session.catch(() => {
    if (state.chat?.session === session) state.chat = undefined;
  });
  return session;
}
