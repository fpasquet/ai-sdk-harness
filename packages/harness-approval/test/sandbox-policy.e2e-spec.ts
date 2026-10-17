import type { SessionManager } from 'ai-sdk-harness-sessions';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defineApprovalPolicy } from '../src/index.js';
import { installClaudeCodePolicies } from '../src/sandbox.js';

/**
 * An approval policy held by the sandbox itself, on real Claude Code sessions in a Docker
 * Sandbox: needs `sbx` signed in, and a credential for Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or
 * `ANTHROPIC_API_KEY`, or the login of the `claude` CLI on this host. Builds the package first:
 * the hook installed in the sandbox is the compiled one.
 */
interface Metadata {
  agent: 'free' | 'read-only';
}

const READ_ONLY = defineApprovalPolicy({
  commands: {
    allow: ['echo', 'pwd', 'ls'],
    deny: [{ match: 'touch', reason: 'No new files in this test.' }],
  },
  edits: { deny: [{ match: '**', reason: 'This agent only reads.' }] },
  default: 'deny',
});
const inSandbox = READ_ONLY.claudeCodeSandbox('read-only');
const policed = createClaudeCode({ ...inSandbox.harness });
const free = createClaudeCode();
const agents = {
  'read-only': new HarnessAgent({
    harness: policed,
    model: 'claude-haiku-4-5',
    ...inSandbox.agent,
  }),
  free: new HarnessAgent({ harness: free, model: 'claude-haiku-4-5', permissionMode: 'allow-all' }),
};

describe('an approval policy held by the sandbox', () => {
  let sandbox: SbxNetworkSandboxSession;
  let sessions: SessionManager<Metadata>;

  /** Sends a message and reads the turn to its end. */
  async function say(id: string, agent: Metadata['agent'], message: string) {
    if ((await sessions.get(id)) === undefined) await sessions.create({ id, metadata: { agent } });
    const turn = await sessions.send(id, { message });
    for await (const _chunk of turn.stream);
    const session = await turn.done;
    expect(session.error).toBeUndefined();
    return { session, messages: JSON.stringify((await sessions.get(id))?.messages) };
  }

  beforeAll(async () => {
    execFileSync('pnpm', ['build'], { cwd: new URL('..', import.meta.url), stdio: 'ignore' });
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-approval-sandbox-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4001, 4002],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [policed, free] }),
    });
    await installClaudeCodePolicies(sandbox, { 'read-only': READ_ONLY });
    sessions = createSessionManager<Metadata>({
      agent: ({ metadata }) => agents[metadata.agent],
      sandboxes: sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4001, 4002] }),
    });
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('installs root files the agent cannot change', async () => {
    const { stdout } = await sandbox.run({
      command:
        'stat -c %U /etc/claude-code/ai-sdk-harness/policies/read-only.json; echo x >> /etc/claude-code/ai-sdk-harness/policies/read-only.json || echo refused',
    });

    expect(stdout).toContain('root');
    expect(stdout).toContain('refused');
  });

  it('runs a command the policy allows, without asking anyone', async () => {
    const { session, messages } = await say(
      'reader',
      'read-only',
      'Run exactly `echo allowed-$((40 + 2))` with the Bash tool, then give its output.',
    );

    expect(session.status).toBe('idle');
    expect(messages).toContain('allowed-42');
    expect(messages).not.toContain('approval-requested');
  });

  it('refuses in the sandbox a command and an edit the policy denies, telling the agent why', async () => {
    const { session, messages } = await say(
      'reader',
      'read-only',
      'Run exactly `touch /tmp/denied.txt` with the Bash tool, then write "hi" to the file ' +
        'notes.txt with the Write tool. Do not try anything else: say what happened.',
    );

    expect(session.status).toBe('idle');
    expect(messages).toContain('No new files in this test.');
    expect(messages).toContain('This agent only reads.');
    expect(messages).not.toContain('approval-requested');
    expect(await sandbox.readTextFile({ path: '/tmp/denied.txt' })).toBeNull();
  });

  it('leaves an agent without a policy free', async () => {
    const { messages } = await say(
      'free',
      'free',
      'Run exactly `touch /tmp/free.txt && echo done-$((40 + 2))` with the Bash tool, then give its output.',
    );

    expect(messages).toContain('done-42');
    expect(await sandbox.readTextFile({ path: '/tmp/free.txt' })).toBe('');
  });
});
