import type { HarnessAgentPermissionMode } from '@ai-sdk/harness/agent';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionManager, SessionStore } from '../src/index.js';

import { createMemorySessionStore, createSessionManager, sharedSandbox } from '../src/index.js';

/**
 * Real Claude Code sessions in one Docker Sandbox: needs `sbx` signed in, and a credential for
 * Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, or the login of the `claude` CLI
 * on this host. The sandbox is removed at the end; the template image, shared with the example, is
 * kept.
 */
interface Metadata {
  permissionMode: HarnessAgentPermissionMode;
}

const harness = createClaudeCode();
const agents = new Map<HarnessAgentPermissionMode, HarnessAgent>();
const agentFor = ({ permissionMode }: Metadata): HarnessAgent => {
  let agent = agents.get(permissionMode);
  if (agent === undefined) {
    agent = new HarnessAgent({ harness, model: 'claude-haiku-4-5', permissionMode });
    agents.set(permissionMode, agent);
  }
  return agent;
};

const text = (messages: { parts: { type: string; text?: string }[] }[] = []): string =>
  messages
    .at(-1)
    ?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('') ?? '';

describe('sessions on a real runtime', () => {
  let sandbox: SbxNetworkSandboxSession;
  let store: SessionStore<Metadata>;
  let sessions: SessionManager<Metadata>;

  const manager = () =>
    createSessionManager<Metadata>({
      agent: ({ metadata }) => agentFor(metadata),
      sandboxes: sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4001, 4002] }),
      store,
    });

  /** Sends a message, reads the turn to its end, and gives the answer's text. */
  async function say(id: string, message: string): Promise<string> {
    const turn = await sessions.send(id, { message });
    for await (const _chunk of turn.stream);
    const session = await turn.done;
    expect(session.error).toBeUndefined();
    return text((await sessions.get(id))?.messages);
  }

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-sessions-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4001, 4002],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
    });
    store = createMemorySessionStore();
    sessions = manager();
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('runs two sessions side by side in one sandbox, each in a directory of its own', async () => {
    await sessions.create({ id: 'alpha', metadata: { permissionMode: 'allow-all' } });
    await sessions.create({ id: 'beta', metadata: { permissionMode: 'allow-all' } });

    const ask = (word: string) =>
      `Remember the word ${word}. Run \`pwd\` with the Bash tool and answer with its output only.`;
    const [alpha, beta] = await Promise.all([
      say('alpha', ask('tangerine')),
      say('beta', ask('obsidian')),
    ]);

    expect(alpha).toContain('alpha');
    expect(beta).toContain('beta');
    expect(alpha).not.toBe(beta);
  });

  it('suspends a session, then resumes it where it was on the next message', async () => {
    await sessions.suspend('alpha');
    expect((await sessions.get('alpha'))?.status).toBe('suspended');

    const answer = await say('alpha', 'What word did I ask you to remember? Answer with it only.');

    expect(answer.toLowerCase()).toContain('tangerine');
  });

  it('resumes, after a restart, a session the shutdown suspended', async () => {
    await sessions.shutdown();
    expect((await store.get('beta'))?.status).toBe('suspended');

    sessions = manager();
    const answer = await say('beta', 'What word did I ask you to remember? Answer with it only.');

    expect(answer.toLowerCase()).toContain('obsidian');
  });

  /** Starts a turn that asks approval for a command, and gives the session waiting for it. */
  async function askApproval(id: string) {
    await sessions.create({ id, metadata: { permissionMode: 'allow-reads' } });
    const turn = await sessions.send(id, {
      message: 'Run exactly `echo approved-$((40 + 2))` with the Bash tool, then give its output.',
    });
    for await (const _chunk of turn.stream);
    const paused = await turn.done;
    expect(paused.status).toBe('awaiting-input');
    const [approval] = paused.pendingInput?.approvals ?? [];
    expect(approval?.toolName).toBe('bash');
    return approval!;
  }

  async function approve(id: string, approvalId: string) {
    const resumed = await sessions.continue(id, {
      toolApprovalContinuations: [{ type: 'tool-approval-response', approvalId, approved: true }],
    });
    for await (const _chunk of resumed.stream);
    return resumed.done;
  }

  it('waits for the approval of a command, then runs it', async () => {
    const approval = await askApproval('gamma');

    const session = await approve('gamma', approval.approvalId);

    expect(session.status).toBe('idle');
    expect(JSON.stringify((await sessions.get('gamma'))?.messages)).toContain('approved-42');
  });

  it('resumes a session suspended while it waited for an approval, and tells the agent', async () => {
    const approval = await askApproval('delta');
    await sessions.suspend('delta');
    const resuming = Date.now();

    const session = await approve('delta', approval.approvalId);

    // Resumed without the bridge its turn waited in: at once, not after the harness's startup
    // timeout of two minutes.
    expect(Date.now() - resuming).toBeLessThan(60_000);
    const messages = JSON.stringify((await sessions.get('delta'))?.messages);
    expect(messages).toContain('"approved":true');
    // Told the answer, Claude Code runs the command again: done, or asking again first. A resumed
    // Claude Code session (harness-claude-code 1.0.152) sends "Continue." in place of the answers
    // to its approvals, so an approval asked after a resume cannot be granted.
    expect(['idle', 'awaiting-input']).toContain(session.status);
    if (session.status === 'idle') expect(messages).toContain('approved-42');
  });
});
