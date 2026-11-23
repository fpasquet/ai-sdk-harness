import type { UIMessageChunk } from 'ai';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionManager, TurnReport } from '../src/index.js';

import { createSessionManager, sharedSandbox, TURN_RETRY_CHUNK } from '../src/index.js';

/**
 * A real Claude Code turn whose bridge is killed in the middle: needs `sbx` signed in, and a
 * credential for Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, or the login of
 * the `claude` CLI on this host. The sandbox is removed at the end.
 */
const harness = createClaudeCode();
const agent = new HarnessAgent({ harness, model: 'claude-haiku-4-5', permissionMode: 'allow-all' });

describe('turn retries on a real runtime', () => {
  let sandbox: SbxNetworkSandboxSession;
  let sessions: SessionManager;
  const errors: { action: string; error: unknown }[] = [];
  const reports: TurnReport[] = [];

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-retries-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4001],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
    });
    sessions = createSessionManager({
      agent: () => agent,
      sandboxes: sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4001] }),
      turnRetries: { attempts: 2, delayMs: 1000 },
      onError: (error, { action }) => errors.push({ action, error }),
      onTurn: (report) => void reports.push(report),
    });
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('runs a turn again in a harness session started again when its bridge dies', async () => {
    await sessions.create({ id: 'retried', metadata: undefined });
    const turn = await sessions.send('retried', {
      message:
        'Run the shell command `sleep 30 && echo slept` with your Bash tool. Once it is over, ' +
        'answer with the single word DONE, and nothing else.',
    });
    const chunks: UIMessageChunk[] = [];
    let killed = false;
    for await (const chunk of turn.stream) {
      chunks.push(chunk);
      // The agent is in its command: the bridge goes, as when its machine is lost.
      if (!killed && chunk.type === 'tool-input-available') {
        killed = true;
        await sandbox.run({ command: "pkill -9 -f 'bridge.mjs --workdir .*retried' || true" });
      }
    }
    const session = await turn.done;

    expect(killed).toBe(true);
    const retries = chunks.filter(({ type }) => type === TURN_RETRY_CHUNK);
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0]).toMatchObject({ data: { attempt: 1, attempts: 2 }, transient: true });
    expect(session.error).toBeUndefined();
    expect(session.status).toBe('idle');
    expect(errors.map(({ action }) => action)).toContain('retry turn');
    expect(reports.at(-1)?.retries).toBeGreaterThanOrEqual(1);
    const record = await sessions.get('retried');
    const answer = record?.messages.at(-1);
    expect(answer?.role).toBe('assistant');
    expect(JSON.stringify(answer?.parts)).toContain('DONE');
  });
});
