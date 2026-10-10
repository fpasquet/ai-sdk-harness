import type { SessionManager } from 'ai-sdk-harness-sessions';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentQuestions, ApprovalGrant } from '../src/index.js';

import {
  answersOf,
  defineApprovalPolicy,
  QUESTIONS_TOOL_NAME,
  suggestGrant,
} from '../src/index.js';

/**
 * An approval policy holding real Claude Code sessions in a Docker Sandbox: needs `sbx` signed
 * in, and a credential for Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, or the
 * login of the `claude` CLI on this host. The sandbox is removed at the end; the template image,
 * shared with the example, is kept.
 */
interface Metadata {
  grants?: ApprovalGrant[];
}

const harness = createClaudeCode();
const policy = defineApprovalPolicy({
  commands: {
    allow: ['echo', 'pwd'],
    deny: [{ match: 'touch', reason: 'No new files in this test.' }],
  },
});
const agent = new HarnessAgent({
  harness,
  model: 'claude-haiku-4-5',
  ...policy.agentSettings(harness),
});

const textOf = (messages: { parts: { type: string; text?: string }[] }[] = []): string =>
  messages
    .at(-1)
    ?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('') ?? '';

describe('an approval policy on a real runtime', () => {
  let sandbox: SbxNetworkSandboxSession;
  let sessions: SessionManager<Metadata>;

  /** Sends a message and reads the turn to its end. */
  async function say(id: string, message: string) {
    if ((await sessions.get(id)) === undefined) await sessions.create({ id, metadata: {} });
    const turn = await sessions.send(id, { message });
    for await (const _chunk of turn.stream);
    const session = await turn.done;
    expect(session.error).toBeUndefined();
    return { session, record: await sessions.get(id) };
  }

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-approval-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4001, 4002],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
    });
    sessions = createSessionManager<Metadata>({
      agent: () => agent,
      sandboxes: sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4001, 4002] }),
      approve: policy.approver<{ session: { metadata: Metadata } }>({
        grants: ({ session }) => session.metadata.grants,
      }),
    });
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('asks Claude Code about commands, the policy deciding', () => {
    expect(policy.agentSettings(harness).permissionMode).toBe('allow-reads');
  });

  it('runs at once a command the policy allows, within the turn', async () => {
    const { session, record } = await say(
      'allowed',
      'Run exactly `echo allowed-$((40 + 2))` with the Bash tool, then give its output.',
    );

    expect(session.status).toBe('idle');
    const messages = JSON.stringify(record?.messages);
    expect(messages).toContain('Allowed by the approval policy (`echo`).');
    expect(messages).toContain('allowed-42');
  });

  it('refuses a command the policy denies, and tells the agent why', async () => {
    const { session, record } = await say(
      'denied',
      'Run exactly `touch /tmp/denied.txt` with the Bash tool. If it is refused, do not try ' +
        'anything else: say REFUSED, then the reason you were given.',
    );

    expect(session.status).toBe('idle');
    expect(JSON.stringify(record?.messages)).toContain('"approved":false');
    expect(textOf(record?.messages)).toContain('REFUSED');
    expect(await sandbox.readTextFile({ path: '/tmp/denied.txt' })).toBeNull();
  });

  it('asks about the rest, then allows it for the session once granted', async () => {
    const { session } = await say(
      'asked',
      'Run exactly `uname -s` with the Bash tool, then give its output.',
    );
    expect(session.status).toBe('awaiting-input');
    const [approval] = session.pendingInput?.approvals ?? [];
    expect(approval?.toolName).toBe('bash');

    // "Always allow `uname`": kept with the session, then the approval answered.
    const { grants } = suggestGrant(approval!);
    expect(grants).toEqual([{ kind: 'command', prefix: 'uname' }]);
    await sessions.update('asked', { metadata: (metadata) => ({ ...metadata, grants }) });
    const resumed = await sessions.continue('asked', {
      toolApprovalContinuations: [
        { type: 'tool-approval-response', approvalId: approval!.approvalId, approved: true },
      ],
    });
    for await (const _chunk of resumed.stream);
    expect((await resumed.done).status).toBe('idle');

    const again = await say('asked', 'Now run exactly `uname -m` with the Bash tool.');
    expect(again.session.status).toBe('idle');
    expect(JSON.stringify(again.record?.messages)).toContain(
      'Allowed for this session: `uname` commands.',
    );
  });

  it('waits for the answers to the questions of the agent, then goes on with them', async () => {
    const { session } = await say(
      'questions',
      'Ask me which color I prefer with the AskUserQuestion tool, offering exactly two options, ' +
        'red and blue. Then answer with the color I picked, in capitals, and nothing else.',
    );
    expect(session.status).toBe('awaiting-input');
    const [call] = session.pendingInput?.toolCalls ?? [];
    expect(call?.toolName).toBe(QUESTIONS_TOOL_NAME);
    const questions = call!.input as AgentQuestions;
    const [question] = questions.questions;
    const blue = question?.options?.find(({ label }) => /blue/i.test(label));
    expect(blue).toBeDefined();

    const resumed = await sessions.continue('questions', {
      toolResultContinuations: [
        {
          type: 'tool-result',
          toolCallId: call!.toolCallId,
          toolName: QUESTIONS_TOOL_NAME,
          output: {
            type: 'json',
            value: answersOf(questions, { [question!.id]: { optionIds: [blue!.id] } }),
          },
        },
      ],
    });
    for await (const _chunk of resumed.stream);

    expect((await resumed.done).status).toBe('idle');
    expect(textOf((await sessions.get('questions'))?.messages)).toContain('BLUE');
  });
});
