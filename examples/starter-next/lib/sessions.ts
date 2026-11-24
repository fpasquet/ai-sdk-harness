import type { SessionManager } from 'ai-sdk-harness-sessions';

import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

// Claude Code, authenticated from CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, else the login of
// the `claude` CLI. Only a placeholder of the credential enters the sandbox.
const agent = new HarnessAgent({ harness: createClaudeCode() });

const SANDBOX_ID = process.env.SANDBOX_ID ?? 'ai-sdk-harness-starter-next';

// One Docker Sandbox for every conversation: the first one creates it, later ones and the next
// starts of the server resume it.
async function openSandbox() {
  const settings = { sandboxId: SANDBOX_ID, ports: [4000] };
  try {
    const sandbox = await resumeSbxNetworkSandboxSession(settings);
    // A previous run of the server may have left its bridges behind, holding their ports.
    await sandbox.killAllProcesses();
    return sandbox;
  } catch (error) {
    if (!(error instanceof SbxSandboxNotFoundError)) throw error;
  }
  return createSbxNetworkSandboxSession({
    ...settings,
    // The Claude Code bridge installs its dependencies with pnpm.
    setup: ['npm install --global --silent pnpm@10'],
    // Installs Claude Code once, in a local image every later sandbox starts from.
    template: await agent.getSandboxTemplate(),
  });
}

function createSessions(): SessionManager {
  return createSessionManager({
    agent: () => agent,
    sandboxes: sharedSandbox({
      open: openSandbox,
      // A port per live conversation, for its bridge: four at once, a fifth suspends the idlest.
      ports: [4001, 4002, 4003, 4004],
    }),
    // A conversation idle for 15 minutes is suspended; its next message resumes it.
    idleTimeoutMs: 15 * 60_000,
  });
}

// Kept on globalThis so that `next dev` reloading this module keeps the conversations.
const globals = globalThis as { starterSessions?: SessionManager };

/** The conversations, each a harness session in the shared sandbox. Kept in memory. */
export const sessions = (): SessionManager => (globals.starterSessions ??= createSessions());
