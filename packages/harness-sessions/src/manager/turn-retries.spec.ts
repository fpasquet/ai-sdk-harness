import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionManager, SessionManagerOptions, TurnReport } from '../index.js';

import { FakeAgent, fakeSandboxes, readAll, until } from '../../test/fakes.js';
import { createSessionManager, TURN_RETRY_CHUNK } from '../index.js';

const BRIDGE_LOST = 'claude-code bridge closed before the turn finished.';

describe('turn retries', () => {
  let agent: FakeAgent;
  let fake: ReturnType<typeof fakeSandboxes>;
  let errors: { action: string; error: unknown }[];
  let reports: TurnReport[];
  let sessions: SessionManager;

  const manager = (options: Partial<SessionManagerOptions<unknown>> = {}) =>
    createSessionManager({
      agent: () => agent,
      sandboxes: fake.sandboxes,
      onError: (error, { action }) => errors.push({ action, error }),
      onTurn: (report) => void reports.push(report),
      turnRetries: { attempts: 2, delayMs: 0 },
      ...options,
    });

  const ready = async () => {
    await sessions.create({ id: 's1', metadata: undefined });
    await until(async () => (await sessions.get('s1'))?.status === 'idle');
  };

  const turn = async (message = 'hello') => {
    const started = await sessions.send('s1', { message });
    const chunks = await readAll(started.stream);
    return { chunks, session: await started.done };
  };

  const retryChunks = (chunks: { type: string }[]) =>
    chunks.filter(({ type }) => type === TURN_RETRY_CHUNK);

  beforeEach(() => {
    agent = new FakeAgent();
    fake = fakeSandboxes();
    errors = [];
    reports = [];
    sessions = manager();
  });
  afterEach(async () => {
    await sessions.shutdown();
  });

  it('runs a turn again after a transient error, in a harness session started again', async () => {
    await ready();
    agent.script.push({ fail: new Error(BRIDGE_LOST) }, { text: 'done' });

    const { chunks, session } = await turn();

    expect(retryChunks(chunks)).toEqual([
      {
        type: TURN_RETRY_CHUNK,
        data: { attempt: 1, attempts: 2, delayMs: 0, error: 'An error occurred.' },
        transient: true,
      },
    ]);
    expect(chunks.filter(({ type }) => type === 'error')).toEqual([]);
    expect(chunks.filter(({ type }) => type === 'start')).toHaveLength(1);
    expect(chunks).toContainEqual({ type: 'text-delta', id: 't', delta: 'done' });
    expect(session).toMatchObject({ status: 'idle', turns: 1 });
    expect(session.error).toBeUndefined();
    expect(agent.prompts).toEqual([
      'hello',
      expect.stringContaining('Carry on with the task from where you stopped.'),
    ]);
    expect(agent.handles).toHaveLength(2);
    expect(agent.handles[0]?.stopped).toBe(true);
    expect(agent.handles[1]?.resumeFrom).toBeDefined();
    expect(errors).toEqual([{ action: 'retry turn', error: new Error(BRIDGE_LOST) }]);
    expect(reports).toMatchObject([{ failure: undefined, retries: 1 }]);
  });

  it('keeps the conversation of the turn as one answer', async () => {
    await ready();
    agent.script.push({ fail: new Error(BRIDGE_LOST) }, { text: 'done' });

    await turn();

    const record = await sessions.get('s1');
    expect(record?.messages.map(({ role }) => role)).toEqual(['user', 'assistant']);
  });

  it('fails with the last error once the retries are used up, the client told each time', async () => {
    await ready();
    agent.script.push(
      { fail: new Error('API Error: Connection dropped (ECONNRESET)') },
      { fail: new Error(BRIDGE_LOST) },
      { fail: new Error('API Error: 529 overloaded_error') },
    );

    const { chunks, session } = await turn();

    expect(retryChunks(chunks)).toMatchObject([
      { data: { attempt: 1, attempts: 2 } },
      { data: { attempt: 2, attempts: 2 } },
    ]);
    expect(chunks.filter(({ type }) => type === 'error')).toEqual([
      { type: 'error', errorText: 'An error occurred.' },
    ]);
    expect(session).toMatchObject({ status: 'idle', error: 'API Error: 529 overloaded_error' });
    expect(agent.prompts).toHaveLength(3);
    expect(reports).toMatchObject([{ failure: 'API Error: 529 overloaded_error', retries: 2 }]);
  });

  it('never runs a turn again after a final error', async () => {
    await ready();
    agent.script.push({ fail: new Error('API Error: 429 rate_limit_error') });

    const { chunks, session } = await turn();

    expect(retryChunks(chunks)).toEqual([]);
    expect(chunks).toContainEqual({ type: 'error', errorText: 'An error occurred.' });
    expect(session).toMatchObject({ status: 'idle', error: 'API Error: 429 rate_limit_error' });
    expect(agent.prompts).toEqual(['hello']);
    expect(agent.handles).toHaveLength(1);
  });

  it('changes nothing without the option', async () => {
    await sessions.shutdown();
    sessions = manager({ turnRetries: undefined });
    await ready();
    agent.script.push({ fail: new Error(BRIDGE_LOST) });

    const { chunks, session } = await turn();

    expect(retryChunks(chunks)).toEqual([]);
    expect(session).toMatchObject({ status: 'idle', error: BRIDGE_LOST });
    expect(agent.prompts).toEqual(['hello']);
    expect(reports).toMatchObject([{ retries: 0 }]);
  });

  it('waits the delay of each retry, and takes its own prompt and judge of errors', async () => {
    await sessions.shutdown();
    const delays: number[] = [];
    sessions = manager({
      turnRetries: {
        attempts: 3,
        delayMs: (attempt) => {
          delays.push(attempt);
          return attempt;
        },
        isTransient: (error) => (error as Error).message === 'flaky',
        prompt: 'Go on.',
      },
    });
    await ready();
    agent.script.push({ fail: new Error('flaky') }, { fail: new Error('flaky') }, { text: 'done' });

    const { chunks } = await turn();

    expect(delays).toEqual([1, 2]);
    expect(retryChunks(chunks)).toMatchObject([
      { data: { attempt: 1, delayMs: 1 } },
      { data: { attempt: 2, delayMs: 2 } },
    ]);
    expect(agent.prompts).toEqual(['hello', 'Go on.', 'Go on.']);
  });

  it('counts a retry that cannot start as one, and fails with its error', async () => {
    await ready();
    agent.script.push({ fail: new Error(BRIDGE_LOST) });
    const failTurn = new Error('socket hang up');
    const stream = agent.stream;
    agent.stream = (options) => {
      if (options.prompt !== 'hello') return Promise.reject(failTurn);
      return stream(options);
    };

    const { chunks, session } = await turn();

    expect(retryChunks(chunks)).toHaveLength(2);
    expect(chunks.filter(({ type }) => type === 'error')).toEqual([
      { type: 'error', errorText: 'An error occurred.' },
    ]);
    expect(session).toMatchObject({ status: 'idle', error: 'socket hang up' });
  });

  it('stops retrying when the turn is interrupted during the delay', async () => {
    await sessions.shutdown();
    sessions = manager({ turnRetries: { attempts: 2, delayMs: 60_000 } });
    await ready();
    agent.script.push({ fail: new Error(BRIDGE_LOST) });

    const started = await sessions.send('s1', { message: 'hello' });
    const chunks = readAll(started.stream);
    await until(() => errors.some(({ action }) => action === 'retry turn'));
    await sessions.interrupt('s1');

    expect(await started.done).toMatchObject({ status: 'idle', error: BRIDGE_LOST });
    expect(retryChunks(await chunks)).toHaveLength(1);
    expect(agent.prompts).toEqual(['hello']);
  });

  it('leaves the session interrupted when its harness session cannot be stopped', async () => {
    await ready();
    agent.script.push({ fail: new Error(BRIDGE_LOST) });
    agent.handles[0]!.failStop = true;

    const { session } = await turn();

    expect(session.status).toBe('interrupted');
    expect(agent.prompts).toEqual(['hello']);
    expect(reports).toMatchObject([{ failure: BRIDGE_LOST, retries: 1 }]);
  });
});
