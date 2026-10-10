import type { UIMessage } from 'ai';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SessionEvent,
  SessionManager,
  SessionManagerOptions,
  SessionStore,
} from '../index.js';

import {
  deferred,
  FakeAgent,
  fakeSandboxes,
  readAll,
  resumeState,
  until,
} from '../../test/fakes.js';
import {
  createMemorySessionStore,
  createSessionManager,
  SessionCapacityError,
  SessionConflictError,
  SessionNotFoundError,
} from '../index.js';

interface Metadata {
  title: string;
}

const APPROVAL_CHUNKS = [
  {
    type: 'tool-input-available',
    toolCallId: 'call-1',
    toolName: 'Bash',
    input: { command: 'ls' },
  },
  { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' },
] as const;

describe('createSessionManager', () => {
  let agent: FakeAgent;
  let fake: ReturnType<typeof fakeSandboxes>;
  let store: SessionStore<Metadata>;
  let errors: { action: string; sessionId?: string; error: unknown }[];
  let sessions: SessionManager<Metadata>;
  let ids: number;

  const manager = (options: Partial<SessionManagerOptions<Metadata>> = {}) =>
    createSessionManager<Metadata>({
      agent: () => agent,
      sandboxes: fake.sandboxes,
      store,
      generateId: () => `id-${(ids += 1)}`,
      onError: (error, context) => errors.push({ ...context, error }),
      ...options,
    });

  /** Creates a session and waits for it to be ready. */
  const ready = async (id = 's1', title = 'First') => {
    await sessions.create({ id, metadata: { title } });
    await until(async () => (await sessions.get(id))?.status === 'idle');
  };

  /** Sends a message and reads the turn to its end. */
  const turn = async (id: string, message: string) => {
    const started = await sessions.send(id, { message });
    const chunks = await readAll(started.stream);
    return { chunks, session: await started.done };
  };

  beforeEach(() => {
    agent = new FakeAgent();
    fake = fakeSandboxes();
    store = createMemorySessionStore();
    errors = [];
    ids = 0;
    sessions = manager();
  });
  afterEach(async () => {
    await sessions.shutdown();
  });

  describe('create', () => {
    it('returns the session preparing, then readies its sandbox and harness session', async () => {
      const created = await sessions.create({ id: 's1', metadata: { title: 'First' } });

      expect(created).toMatchObject({
        id: 's1',
        status: 'preparing',
        metadata: { title: 'First' },
        turns: 0,
      });
      await until(async () => (await sessions.get('s1'))?.status === 'idle');
      expect(fake.events).toEqual(['acquire s1']);
      expect(agent.handles[0]).toMatchObject({ sessionId: 's1', resumeFrom: undefined });
      expect(agent.handles[0]?.sandboxSession).toEqual({ id: 'box-s1' });
    });

    it('names the session itself when no id is given', async () => {
      const created = await sessions.create({ metadata: { title: 'Untitled' } });

      expect(created.id).toBe('id-1');
    });

    it('refuses an id another session has', async () => {
      await sessions.create({ id: 's1', metadata: { title: 'First' } });

      await expect(sessions.create({ id: 's1', metadata: { title: 'Again' } })).rejects.toThrow(
        SessionConflictError,
      );
    });

    it('builds the agent from the metadata, for each start', async () => {
      const agentFor = vi.fn(() => agent);
      sessions = manager({ agent: agentFor });

      await ready('s1', 'Mine');

      expect(agentFor).toHaveBeenCalledWith({ id: 's1', metadata: { title: 'Mine' } });
    });

    it('marks a session that cannot start failed, and starts it again on the next message', async () => {
      agent.failStart = new Error('no bridge');
      await sessions.create({ id: 's1', metadata: { title: 'First' } });
      await until(async () => (await sessions.get('s1'))?.status === 'failed');
      expect((await sessions.get('s1'))?.error).toBe('no bridge');
      expect(errors).toEqual([expect.objectContaining({ action: 'start', sessionId: 's1' })]);
      expect(fake.events).toEqual(['acquire s1', 'close s1']);

      agent.failStart = undefined;
      const { session } = await turn('s1', 'hello');

      expect(session.status).toBe('idle');
      expect(session.error).toBeUndefined();
    });

    it('refuses a message to a session that failed again', async () => {
      fake.failAcquire.error = new Error('no sandbox');
      await sessions.create({ id: 's1', metadata: { title: 'First' } });
      await until(async () => (await sessions.get('s1'))?.status === 'failed');

      await expect(sessions.send('s1', { message: 'hello' })).rejects.toThrow('no sandbox');
    });
  });

  describe('send', () => {
    it('streams a turn and keeps the conversation, the turns and the usage', async () => {
      await ready();

      const { chunks, session } = await turn('s1', 'hello');

      expect(chunks).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text-delta', delta: 'ok' })]),
      );
      expect(agent.prompts).toEqual(['hello']);
      expect(session).toMatchObject({
        status: 'idle',
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      });
      const record = await sessions.get('s1');
      expect(record?.messages.map(({ role }) => role)).toEqual(['user', 'assistant']);
      expect((await store.get('s1'))?.messages).toHaveLength(2);
    });

    it('waits for a session still preparing', async () => {
      const opened = deferred();
      sessions = manager({
        agent: async () => {
          await opened.promise;
          return agent;
        },
      });
      await sessions.create({ id: 's1', metadata: { title: 'First' } });

      const sending = sessions.send('s1', { message: 'hello' });
      opened.resolve();

      await expect(readAll((await sending).stream)).resolves.not.toEqual([]);
    });

    it('sends the agent the prompt, and keeps the message as it was written', async () => {
      await ready();
      const message: UIMessage = {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: '/explain src' }],
      };

      const started = await sessions.send('s1', { message, prompt: 'Explain src to a newcomer.' });
      await readAll(started.stream);
      await started.done;

      expect(agent.prompts).toEqual(['Explain src to a newcomer.']);
      expect((await sessions.get('s1'))?.messages[0]).toEqual(message);
    });

    it('runs one turn at a time', async () => {
      await ready();
      const hold = deferred();
      agent.script.push({ hold: hold.promise });
      const first = await sessions.send('s1', { message: 'one' });

      expect((await sessions.get('s1'))?.status).toBe('busy');
      await expect(sessions.send('s1', { message: 'two' })).rejects.toMatchObject({
        status: 'busy',
      });
      hold.resolve();
      await readAll(first.stream);
    });

    it('settles a turn the client stopped reading', async () => {
      await ready();

      const started = await sessions.send('s1', { message: 'hello' });
      await started.stream.cancel();

      await expect(started.done).resolves.toMatchObject({ status: 'idle', turns: 1 });
    });

    it('keeps the error of a turn that failed, and tells the client its message', async () => {
      sessions = manager({ errorMessage: () => 'The agent failed.' });
      await ready();
      agent.script.push({ fail: new Error('model overloaded') });

      const { chunks, session } = await turn('s1', 'hello');

      expect(chunks).toContainEqual({ type: 'error', errorText: 'The agent failed.' });
      expect(session).toMatchObject({ status: 'idle', error: 'model overloaded' });
    });

    it('rejects, and stays ready, when the turn cannot start', async () => {
      await ready();
      agent.failTurn = new Error('bridge gone');

      await expect(sessions.send('s1', { message: 'hello' })).rejects.toThrow('bridge gone');

      expect(await sessions.get('s1')).toMatchObject({ status: 'idle', error: 'bridge gone' });
    });

    it('cuts a turn that takes too long', async () => {
      sessions = manager({ turnTimeoutMs: 20 });
      await ready();
      agent.script.push({ hold: new Promise(() => undefined) });

      const { session } = await turn('s1', 'hello');

      expect(session).toMatchObject({ status: 'idle', error: 'The turn took too long.' });
    });

    it('stops with the caller signal', async () => {
      await ready();
      agent.script.push({ hold: new Promise(() => undefined) });
      const abort = new AbortController();

      const started = await sessions.send('s1', { message: 'hello', abortSignal: abort.signal });
      abort.abort(new Error('stopped by the user'));

      await expect(started.done).resolves.toMatchObject({ error: 'stopped by the user' });
    });

    it('answers a route with the stream', async () => {
      await ready();

      const started = await sessions.send('s1', { message: 'hello' });
      const response = started.toUIMessageStreamResponse({ headers: { 'x-session': 's1' } });

      expect(response.headers.get('x-session')).toBe('s1');
      expect(await response.text()).toContain('"delta":"ok"');
    });

    it('refuses a session that does not exist, or is over', async () => {
      await expect(sessions.send('ghost', { message: 'hello' })).rejects.toThrow(
        SessionNotFoundError,
      );
      await ready();
      await sessions.close('s1');

      await expect(sessions.send('s1', { message: 'hello' })).rejects.toMatchObject({
        status: 'closed',
      });
    });
  });

  describe('awaiting input', () => {
    const approvalAnswer = (approved: boolean): UIMessage => ({
      id: 'id-2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-Bash',
          toolCallId: 'call-1',
          state: 'approval-responded',
          input: { command: 'ls' },
          approval: { id: 'approval-1', approved, reason: 'fine' },
        },
      ],
    });

    beforeEach(async () => {
      await ready();
      agent.script.push({ chunks: [...APPROVAL_CHUNKS], unfinished: true });
      await turn('s1', 'list the files');
    });

    it('waits for the answers of the turn that paused', async () => {
      const session = await sessions.get('s1');

      expect(session).toMatchObject({
        status: 'awaiting-input',
        pendingInput: {
          approvals: [
            {
              approvalId: 'approval-1',
              toolCallId: 'call-1',
              toolName: 'Bash',
              input: { command: 'ls' },
            },
          ],
          toolCalls: [],
        },
      });
      await expect(sessions.send('s1', { message: 'and now?' })).rejects.toThrow(
        /answer it with continue\(\) first/,
      );
    });

    it('continues the turn with the answers useChat sends back', async () => {
      const started = await sessions.continue('s1', { message: approvalAnswer(true) });
      await readAll(started.stream);
      const session = await started.done;

      expect(agent.continuations).toEqual([
        {
          toolApprovalContinuations: [
            {
              type: 'tool-approval-response',
              approvalId: 'approval-1',
              approved: true,
              reason: 'fine',
            },
          ],
          toolResultContinuations: [],
        },
      ]);
      expect(session.status).toBe('idle');
      expect(session.pendingInput).toBeUndefined();
      const [, answer] = (await sessions.get('s1'))?.messages ?? [];
      expect(answer?.parts).toContainEqual(
        expect.objectContaining({
          state: 'approval-responded',
          approval: expect.objectContaining({ approved: true }) as unknown,
        }),
      );
    });

    it('refuses a continuation that answers nothing', async () => {
      await expect(sessions.continue('s1', {})).rejects.toThrow(/carries no answer/);
    });

    it('is suspended with what it waits for, and resumed without the turn it lost', async () => {
      await sessions.suspend('s1');
      expect(await sessions.get('s1')).toMatchObject({
        status: 'suspended',
        pendingInput: { approvals: [expect.objectContaining({ approvalId: 'approval-1' })] },
      });
      expect(await store.getResumeState('s1')).toEqual(resumeState('s1', true));

      agent.handles.length = 0;
      const started = await sessions.continue('s1', {
        toolApprovalContinuations: [
          {
            type: 'tool-approval-response',
            approvalId: 'approval-1',
            approved: false,
            reason: 'not now',
          },
        ],
      });
      await readAll(started.stream);

      // The bridge of the lost turn is gone: the session resumes without it.
      expect(agent.handles[0]?.resumeFrom).toEqual(resumeState('s1'));
      expect(agent.continuations).toEqual([]);
      expect(agent.prompts.at(-1)).toBe(
        'The session was suspended while you waited for my answers. Here they are; carry on from there:\n' +
          '- I deny Bash {"command":"ls"}: not now',
      );
      expect((await started.done).status).toBe('idle');
    });

    it('waits for the answers once resumed without its turn, and refuses a message meanwhile', async () => {
      await sessions.suspend('s1');
      await expect(sessions.send('s1', { message: 'and now?' })).rejects.toThrow(
        /answer it with continue\(\) first/,
      );
      expect((await sessions.get('s1'))?.status).toBe('awaiting-input');
    });

    it('refuses continue() on a session that waits for nothing', async () => {
      const started = await sessions.continue('s1', { message: approvalAnswer(false) });
      await readAll(started.stream);
      await started.done;

      await expect(sessions.continue('s1', { message: approvalAnswer(false) })).rejects.toThrow(
        /waits for no input/,
      );
    });
  });

  describe('suspension', () => {
    it('suspends a session left idle, then resumes it on the next message', async () => {
      sessions = manager({ idleTimeoutMs: 20 });
      await ready();
      await turn('s1', 'hello');

      await until(async () => (await sessions.get('s1'))?.status === 'suspended');
      expect(agent.handles[0]?.stopped).toBe(true);
      expect(await store.getResumeState('s1')).toEqual(resumeState('s1'));
      expect(fake.events).toEqual(['acquire s1', 'suspend s1']);

      const { session } = await turn('s1', 'again');

      expect(session).toMatchObject({ status: 'idle', turns: 2 });
      expect(agent.handles[1]?.resumeFrom).toEqual(resumeState('s1'));
      expect(fake.events.at(-1)).toBe('acquire s1 (resume)');
      expect(await store.getResumeState('s1')).toBeUndefined();
    });

    it('keeps a session suspended when its resume fails, so the next message tries again', async () => {
      await ready();
      await sessions.suspend('s1');
      agent.failStart = new Error('sandbox gone');

      await expect(sessions.send('s1', { message: 'hello' })).rejects.toThrow(SessionConflictError);

      expect(await sessions.get('s1')).toMatchObject({
        status: 'suspended',
        error: 'sandbox gone',
      });
      expect(await store.getResumeState('s1')).toEqual(resumeState('s1'));
      agent.failStart = undefined;
      await expect(turn('s1', 'hello')).resolves.toMatchObject({
        session: { status: 'idle' },
      });
    });

    it('interrupts a session whose harness session cannot be stopped', async () => {
      await ready();
      agent.handles[0]!.failStop = true;

      await sessions.suspend('s1');

      expect(await sessions.get('s1')).toMatchObject({ status: 'interrupted' });
      expect(errors).toContainEqual(expect.objectContaining({ action: 'stop', sessionId: 's1' }));
    });

    it('interrupts a suspended session with nothing kept to resume from', async () => {
      await ready();
      await sessions.suspend('s1');
      await store.save((await store.get('s1'))!);

      await expect(sessions.send('s1', { message: 'hello' })).rejects.toThrow(/Nothing was kept/);
      expect((await sessions.get('s1'))?.status).toBe('interrupted');
    });

    it('suspends a session on request, and only an idle one', async () => {
      await expect(sessions.suspend('ghost')).rejects.toThrow(SessionNotFoundError);
      await ready();
      agent.script.push({ hold: new Promise(() => undefined) });
      await sessions.send('s1', { message: 'hello' });

      await expect(sessions.suspend('s1')).rejects.toMatchObject({ status: 'busy' });
      await sessions.interrupt('s1');
      await expect(sessions.suspend('s1')).resolves.toMatchObject({ status: 'suspended' });
      await expect(sessions.suspend('s1')).resolves.toMatchObject({ status: 'suspended' });
      await sessions.close('s1');
      await expect(sessions.suspend('s1')).rejects.toMatchObject({ status: 'closed' });
    });

    it('closes a session suspended for too long', async () => {
      sessions = manager({ closeSuspendedAfterMs: 20 });
      await ready();
      await sessions.suspend('s1');

      await until(async () => (await sessions.get('s1'))?.status === 'closed');
      expect(fake.events).toContain('discard s1');
    });
  });

  describe('capacity', () => {
    beforeEach(() => {
      fake = fakeSandboxes(1);
    });

    it('suspends the session idle the longest to make room', async () => {
      sessions = manager();
      await ready('s1');
      await ready('s2');

      expect((await sessions.get('s1'))?.status).toBe('suspended');
      const { session } = await turn('s1', 'back');
      expect(session.status).toBe('idle');
      expect((await sessions.get('s2'))?.status).toBe('suspended');
    });

    it('refuses a session when no live one is idle, or when told not to suspend', async () => {
      sessions = manager();
      await ready('s1');
      agent.script.push({ hold: new Promise(() => undefined) });
      await sessions.send('s1', { message: 'busy' });

      await expect(sessions.create({ id: 's2', metadata: { title: 'Two' } })).rejects.toThrow(
        SessionCapacityError,
      );

      await sessions.interrupt('s1');
      const strict = manager({ suspendIdleWhenFull: false, store: createMemorySessionStore() });
      await strict.create({ id: 'a', metadata: { title: 'A' } });
      await expect(strict.create({ id: 'b', metadata: { title: 'B' } })).rejects.toMatchObject({
        capacity: 1,
      });
      await strict.shutdown();
    });
  });

  describe('interrupt', () => {
    it('cuts the turn under way short, and leaves the session ready', async () => {
      await ready();
      agent.script.push({ hold: new Promise(() => undefined) });
      const started = await sessions.send('s1', { message: 'hello' });

      await sessions.interrupt('s1');

      expect(await started.done).toMatchObject({
        status: 'idle',
        error: 'The turn was interrupted.',
      });
    });

    it('does nothing when no turn is under way, and refuses an unknown session', async () => {
      await ready();
      await expect(sessions.interrupt('s1')).resolves.toBeUndefined();
      await sessions.suspend('s1');
      await expect(sessions.interrupt('s1')).resolves.toBeUndefined();
      await expect(sessions.interrupt('ghost')).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe('close and delete', () => {
    it('ends a live session: its harness session is destroyed and its sandbox handed back', async () => {
      await ready();

      const closed = await sessions.close('s1');

      expect(closed.status).toBe('closed');
      expect(agent.handles[0]?.destroyed).toBe(true);
      expect(fake.events).toEqual(['acquire s1', 'close s1']);
      await expect(sessions.close('s1')).resolves.toMatchObject({ status: 'closed' });
    });

    it('cuts the turn of a session closed while busy', async () => {
      await ready();
      agent.script.push({ hold: new Promise(() => undefined) });
      const started = await sessions.send('s1', { message: 'hello' });

      await sessions.close('s1');

      await expect(started.done).resolves.toMatchObject({ status: 'closed' });
    });

    it('discards what a suspended session keeps', async () => {
      await ready();
      await sessions.suspend('s1');

      await sessions.close('s1');

      expect(fake.events.at(-1)).toBe('discard s1');
      expect(await store.getResumeState('s1')).toBeUndefined();
    });

    it('forgets a deleted session', async () => {
      const events: SessionEvent<Metadata>[] = [];
      sessions.subscribe((event) => events.push(event));
      await ready();

      await sessions.delete('s1');

      expect(await sessions.get('s1')).toBeUndefined();
      expect(await store.get('s1')).toBeUndefined();
      expect(events.at(-1)).toEqual({ type: 'deleted', sessionId: 's1' });
      await expect(sessions.close('ghost')).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe('list and events', () => {
    it('lists the sessions, the most recently updated first, live ones as they stand', async () => {
      await ready('s1', 'One');
      await ready('s2', 'Two');
      await turn('s1', 'hello');

      const listed = await sessions.list();

      expect(listed.map(({ id, status }) => [id, status])).toEqual([
        ['s1', 'idle'],
        ['s2', 'idle'],
      ]);
      expect(listed[0]).not.toHaveProperty('messages');
    });

    it('tells the subscribers every change, until they unsubscribe', async () => {
      const events: SessionEvent<Metadata>[] = [];
      const unsubscribe = sessions.subscribe((event) => events.push(event));
      sessions.subscribe(() => {
        throw new Error('broken listener');
      });

      await ready();
      await turn('s1', 'hello');
      unsubscribe();
      await sessions.suspend('s1');

      expect(
        events.map((event) => (event.type === 'updated' ? event.session.status : event.type)),
      ).toEqual(['preparing', 'idle', 'busy', 'idle']);
      expect(errors).toContainEqual(expect.objectContaining({ action: 'listener' }));
    });

    it('reports a write the store could not do, and carries on', async () => {
      store.save = () => Promise.reject(new Error('disk full'));

      await ready();

      expect(errors).toContainEqual(expect.objectContaining({ action: 'write', sessionId: 's1' }));
    });
  });

  describe('shutdown and recovery', () => {
    it('suspends the live sessions, cutting a turn short, and shuts the sandboxes down', async () => {
      await ready('s1');
      await ready('s2');
      agent.script.push({ hold: new Promise(() => undefined) });
      await sessions.send('s2', { message: 'long' });

      await sessions.shutdown();

      expect(await store.get('s1')).toMatchObject({ status: 'suspended' });
      expect(await store.get('s2')).toMatchObject({
        status: 'suspended',
        error: expect.stringContaining('cut short') as unknown,
      });
      expect(fake.events.at(-1)).toBe('shutdown');
      await expect(sessions.send('s1', { message: 'hello' })).rejects.toThrow(/shut down/);
      await expect(sessions.shutdown()).resolves.toBeUndefined();
    });

    it('leaves a session still preparing failed, or suspended when it was resuming', async () => {
      const opened = deferred();
      let wait = false;
      sessions = manager({
        agent: async () => {
          if (wait) await opened.promise;
          return agent;
        },
      });
      await ready('s1');
      await sessions.suspend('s1');
      wait = true;
      const resuming = sessions.send('s1', { message: 'hello' });
      await sessions.create({ id: 's2', metadata: { title: 'Two' } });
      await until(() => agent.handles.length === 1);

      const stopping = sessions.shutdown();
      opened.resolve();
      await stopping;
      await resuming.catch(() => undefined);

      expect(await store.get('s1')).toMatchObject({ status: 'suspended' });
      expect(await store.get('s2')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('before the session was ready') as unknown,
      });
    });

    it('resumes, after a restart, the sessions a shutdown suspended', async () => {
      await ready();
      await turn('s1', 'hello');
      await sessions.shutdown();

      sessions = manager();
      const { session } = await turn('s1', 'again');

      expect(session).toMatchObject({ status: 'idle', turns: 2 });
      expect(agent.handles.at(-1)?.resumeFrom).toEqual(resumeState('s1'));
    });

    it('interrupts, at the next start, the sessions left live by a crash', async () => {
      await ready();

      const restarted = manager();

      await until(async () => (await restarted.get('s1'))?.status === 'interrupted');
      expect((await restarted.get('s1'))?.error).toMatch(/without suspending/);
      await expect(restarted.send('s1', { message: 'hello' })).rejects.toMatchObject({
        status: 'interrupted',
      });
      await restarted.shutdown();
    });
  });
});
