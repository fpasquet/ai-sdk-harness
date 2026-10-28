import type { UIMessageChunk } from 'ai';
import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionManager } from '../src/index.js';

import {
  createMemorySessionStore,
  createSessionManager,
  createTaskList,
  sharedSandbox,
  tasksOf,
} from '../src/index.js';

/**
 * The task list of a real Claude Code session, over two turns, in a Docker Sandbox: needs `sbx`
 * signed in, and a credential for Claude Code — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`,
 * or the login of the `claude` CLI on this host. The sandbox is removed at the end; the template
 * image, shared with the example, is kept.
 */
const harness = createClaudeCode({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
const agent = new HarnessAgent({ harness, model: 'claude-haiku-4-5', permissionMode: 'allow-all' });

describe('the task list of a real runtime', () => {
  let sandbox: SbxNetworkSandboxSession;
  let sessions: SessionManager<Record<string, never>>;
  // Followed chunk by chunk, as a server reading the turns would.
  const followed = createTaskList();

  /** Sends a message and follows the task list through the turn's chunks. */
  async function say(message: string): Promise<void> {
    const turn = await sessions.send('tasks', { message });
    for await (const chunk of turn.stream as AsyncIterable<UIMessageChunk>) {
      if (chunk.type === 'tool-input-available') followed.call(chunk);
      if (chunk.type === 'tool-output-available') followed.result(chunk);
      if (chunk.type === 'tool-output-error') followed.result({ ...chunk, failed: true });
    }
    const session = await turn.done;
    expect(session.error).toBeUndefined();
  }

  const conversation = async () => (await sessions.get('tasks'))?.messages ?? [];

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-tasks-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4001],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({ harnesses: [harness] }),
    });
    sessions = createSessionManager({
      agent: () => agent,
      sandboxes: sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [4001] }),
      store: createMemorySessionStore(),
    });
    await sessions.create({ id: 'tasks', metadata: {} });
  });

  afterAll(async () => {
    await sessions?.shutdown();
    await sandbox?.destroy();
  });

  it('reads the list the agent keeps task by task, and keeps it from one turn to the next', async () => {
    await say(
      'Use TaskCreate to create two tasks, "Write hello.txt" and "Count its words", then do them in ' +
        'order: mark each in progress with TaskUpdate when you start it, and completed when it is ' +
        'done. hello.txt holds "hello from the sandbox".',
    );
    const first = tasksOf(await conversation());
    expect(first.map(({ subject, status }) => [subject, status])).toEqual([
      ['Write hello.txt', 'completed'],
      ['Count its words', 'completed'],
    ]);

    await say(
      'Use TaskCreate to add a third task, "Delete hello.txt", and do it the same way, with TaskUpdate.',
    );
    const tasks = tasksOf(await conversation());
    expect(tasks).toHaveLength(3);
    expect(tasks.every(({ status }) => status === 'completed')).toBe(true);
    expect(new Set(tasks.map(({ id }) => id)).size).toBe(3);
    expect(followed.tasks).toEqual(tasks);
  }, 600_000);
});
