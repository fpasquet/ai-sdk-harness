import type { Plugin } from 'ai-sdk-harness-plugins';
import type { SessionManager, SessionSummary } from 'ai-sdk-harness-sessions';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { withPlugins } from 'ai-sdk-harness-plugins';
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';
import { join } from 'node:path';

import type { Conversation } from '@/lib/conversations';
import type { HarnessId } from '@/lib/harnesses';

import { APPROVAL_POLICY } from '@/lib/approval';
import { resolveSelection } from '@/lib/plugins';
import { openSandbox, SANDBOX, SANDBOX_INSTRUCTIONS, SUSPEND_AFTER_MS } from '@/lib/sandbox';
import { createFileSessionStore } from '@/lib/session-store';

/**
 * The two harnesses, each authenticated from the environment: Claude Code from
 * `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, Codex from `OPENAI_API_KEY`. Without them,
 * each falls back to the login of its own CLI on this machine, when it finds one.
 */
const HARNESS_ADAPTERS = {
  'claude-code': createClaudeCode(),
  codex: createCodex(),
};

/**
 * The ports the bridges of the conversations listen on in the sandbox: 4001 to 4004.
 *
 * Claude Code and Codex run behind a bridge, a process the harness starts in the sandbox, which
 * listens on a port the server reaches over a WebSocket. Two sessions cannot share a port: each
 * conversation works in a view of the sandbox (`fork()`) with a port of its own, the same microVM
 * and files, and a working directory of its own.
 *
 * Their number is how many conversations are live at once — preparing, working, ready or waiting
 * for an approval —, not how many are open: a suspended one holds no port, and resumes on its next
 * message. With four ports:
 *
 * - a fifth conversation suspends the one idle the longest, and takes its port;
 * - when none of the four is idle (working, or waiting for an approval), it is refused with
 *   `SessionCapacityError`, which the route answers with a 503.
 *
 * To run ten turns at the same time, give ten ports, and the sandbox the CPUs and memory ten
 * runtimes need (`cpus` and `memory` of `createSbxNetworkSandboxSession()`); or a sandbox per
 * conversation, with `sandboxPerSession()`.
 */
const SESSION_PORTS = Array.from({ length: 4 }, (_, i) => 4001 + i);

const approveByPolicy = APPROVAL_POLICY.approver<{ session: SessionSummary<Conversation> }>({
  grants: ({ session }) => session.metadata.grants,
});

interface ExampleState {
  /**
   * One agent per harness, model, permission mode and marketplace selection (by its fingerprint),
   * built the first time a conversation asks for it.
   */
  agents: Map<string, HarnessAgent>;
  sessions?: SessionManager<Conversation>;
}

// Kept on globalThis so `next dev` reloading this module keeps the conversations, and does not
// start a second manager on the same store.
const globals = globalThis as { __aiSdkSessionsExample?: ExampleState };
const state: ExampleState = (globals.__aiSdkSessionsExample ??= { agents: new Map() });

/**
 * The agent running `harness` on `model`, with `plugins`: their tools and skills join the agent,
 * and their hooks, subagents and files are written in each session's working directory. What a
 * runtime cannot take (Codex and hooks) is left out, with a warning in the server's log. With
 * `askFirst`, the agent asks before it edits a file or runs a command, for the approval policy to
 * decide: `APPROVAL_POLICY.agentSettings()` gives it the permission mode that makes it ask.
 */
function agentFor(
  { harness, model, askFirst }: Pick<Conversation, 'askFirst' | 'harness' | 'model'>,
  { fingerprint, plugins }: { fingerprint: string; plugins: Plugin[] },
): HarnessAgent {
  const key = `${harness}:${model}:${askFirst}:${fingerprint}`;
  let agent = state.agents.get(key);
  if (agent === undefined) {
    const adapter = HARNESS_ADAPTERS[harness as HarnessId];
    agent = new HarnessAgent(
      withPlugins(
        {
          id: `example-${harness}`,
          harness: adapter,
          model,
          instructions: SANDBOX_INSTRUCTIONS[SANDBOX],
          ...(askFirst
            ? APPROVAL_POLICY.agentSettings(adapter)
            : { permissionMode: 'allow-all' as const }),
        },
        plugins,
      ),
    );
    state.agents.set(key, agent);
  }
  return agent;
}

/**
 * The conversations of the example, each a session of `ai-sdk-harness-sessions`:
 *
 * - They share one sandbox, a Docker Sandbox or a Cloud Run sandbox (`EXAMPLE_SANDBOX`), each in a
 *   view of it with a port of its own: several conversations run at once.
 * - A conversation idle for `EXAMPLE_SUSPEND_AFTER_MS` is suspended: its harness session stops and
 *   its port is freed. The next message resumes it. On Cloud Run, the sandbox itself is suspended
 *   once no conversation holds it: nothing runs, nothing is billed.
 * - They are kept in `.data/sessions` (`EXAMPLE_SESSIONS_DIR`), so they outlive the dev server:
 *   stopping it suspends them, and the next start resumes them on their next message.
 */
export function sessions(): SessionManager<Conversation> {
  state.sessions ??= createExampleSessions();
  return state.sessions;
}

function createExampleSessions(): SessionManager<Conversation> {
  const manager = createSessionManager<Conversation>({
    agent: async ({ metadata }) => agentFor(metadata, await resolveSelection(metadata.selection)),
    sandboxes: sharedSandbox({
      // The first creation installs both Claude Code and Codex in the sandbox, then saves it as a
      // template (a few minutes); every later one starts from that template in seconds.
      open: () =>
        openSandbox(() =>
          createHarnessSandboxTemplate({ harnesses: Object.values(HARNESS_ADAPTERS) }),
        ),
      ports: SESSION_PORTS,
      stopWhenUnused: SANDBOX === 'cloud-run',
    }),
    store: createFileSessionStore<Conversation>(
      process.env.EXAMPLE_SESSIONS_DIR ?? join(process.cwd(), '.data/sessions'),
    ),
    idleTimeoutMs: SUSPEND_AFTER_MS,
    // A conversation that asks first: the policy answers what it decides, within the turn, and
    // allows what you allowed for the rest of the conversation. The rest waits for you.
    approve: (approval, context) =>
      context.session.metadata.askFirst ? approveByPolicy(approval, context) : undefined,
  });
  // Suspended rather than lost when the dev server stops: the next start resumes them.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void manager.shutdown().finally(() => process.exit(0));
    });
  }
  return manager;
}
