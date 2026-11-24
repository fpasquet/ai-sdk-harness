import type { SessionManager } from 'ai-sdk-harness-sessions';

import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { harnessHosts, networkPolicy, trustedHosts } from 'ai-sdk-harness-network';
import { withPlugins } from 'ai-sdk-harness-plugins';
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';
import { withWorkspace } from 'ai-sdk-harness-workspace';
import {
  createSbxNetworkSandboxSession,
  resumeSbxNetworkSandboxSession,
  SbxSandboxNotFoundError,
} from 'ai-sdk-sandbox-sbx';

import { plugin } from '@/lib/plugin';
import { policy } from '@/lib/policy';
import { workspace } from '@/lib/workspace';

/** What the page keeps of a conversation. */
export interface Conversation {
  title: string;
}

// Claude Code, authenticated from CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, else the login of
// the `claude` CLI: only a placeholder of the credential enters the sandbox. It asks before what
// the policy decides, works in a checkout of the repository, and has the plugin.
const harness = createClaudeCode();
const settings = { harness, ...policy.agentSettings(harness) };
const agent = new HarnessAgent(
  withPlugins(workspace ? withWorkspace(settings, workspace) : settings, [plugin]),
);

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
    // Closed to all but what the agent needs, with ai-sdk-harness-network: Claude Code's install
    // and API, GitHub and the JavaScript registries, and the repository's host.
    networkPolicy: networkPolicy(
      harnessHosts('claude-code'),
      trustedHosts('github', 'javascript'),
      (await workspace?.hosts()) ?? [],
    ),
    // The Claude Code bridge installs its dependencies with pnpm.
    setup: ['npm install --global --silent pnpm@10'],
    // Installs Claude Code once, in a local image every later sandbox starts from.
    template: await agent.getSandboxTemplate(),
  });
}

function createSessions(): SessionManager<Conversation> {
  const sandboxes = sharedSandbox({
    open: openSandbox,
    // A port per live conversation, for its bridge: four at once, a fifth suspends the idlest.
    ports: [4001, 4002, 4003, 4004],
  });
  return createSessionManager<Conversation>({
    agent: () => agent,
    // With a repository, each conversation gets its checkout: kept while it is suspended.
    sandboxes: workspace ? workspace.sandboxes(sandboxes) : sandboxes,
    // The policy answers what it decides within the turn; the rest waits for you.
    approve: policy.approver(),
    // A conversation idle for 15 minutes is suspended; its next message resumes it.
    idleTimeoutMs: 15 * 60_000,
  });
}

// Kept on globalThis so that `next dev` reloading this module keeps the conversations.
const globals = globalThis as { starterSessions?: SessionManager<Conversation> };

/** The conversations, each a harness session in the shared sandbox. Kept in memory. */
export const sessions = (): SessionManager<Conversation> =>
  (globals.starterSessions ??= createSessions());
