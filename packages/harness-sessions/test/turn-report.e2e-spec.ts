import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionManager, TurnReport } from '../src/index.js';

import { createMemorySessionStore, createSessionManager, sharedSandbox } from '../src/index.js';

/**
 * What `onTurn` reports of a real Claude Code turn, in a Docker Sandbox: needs `sbx` signed in, and
 * a credential for Claude Code (or the login of the `claude` CLI on this host). Set
 * `TURN_REPORT_FILE` to write the report there, to read what Claude Code really sends.
 */
const harness = createClaudeCode();
const agent = new HarnessAgent({ harness, model: 'claude-haiku-4-5', permissionMode: 'allow-all' });

describe('the report of a real turn', () => {
  let sandbox: SbxNetworkSandboxSession;
  let sessions: SessionManager;
  const reports: TurnReport[] = [];

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-turn-report-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4011],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
    });
    sessions = createSessionManager({
      agent: () => agent,
      sandboxes: sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4011] }),
      store: createMemorySessionStore(),
      onTurn: (report) => {
        reports.push(report);
      },
    });
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('gives the model, the tokens with the cache, each tool called with its input, and the raw events', async () => {
    await sessions.create({ id: 'report', metadata: {} });
    const turn = await sessions.send('report', {
      message: 'Run `echo turn-report` with the Bash tool, then answer with its output only.',
    });
    for await (const _chunk of turn.stream);
    await turn.done;

    const [report] = reports;
    if (process.env.TURN_REPORT_FILE) {
      writeFileSync(process.env.TURN_REPORT_FILE, JSON.stringify(report, null, 2));
    }
    if (report === undefined) throw new Error('onTurn was not called');
    expect(report.failure).toBeUndefined();
    expect(report.usage.inputTokens).toBeGreaterThan(0);
    expect(report.usage.outputTokens).toBeGreaterThan(0);
    expect(report.usage.inputTokenDetails.cacheReadTokens).toBeDefined();
    expect(report.steps.length).toBeGreaterThanOrEqual(2);
    expect(report.steps[0]?.modelId).toMatch(/^claude-haiku-4-5/);
    const commands = report.steps
      .flatMap(({ toolCalls }) => toolCalls)
      .map(({ input }) => (input as { command?: string }).command);
    expect(commands).toContain('echo turn-report');
    expect(report.rawEvents.length).toBeGreaterThan(0);
  });
});
