import type { HarnessAgentResumeSessionState, HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { JSONValue, UIMessage } from 'ai';

import { getHarnessErrorMessage } from '@ai-sdk/harness/agent';
import { createUIMessageStreamResponse } from 'ai';
import { randomUUID } from 'node:crypto';

import type { SessionStreamResult } from '../definitions/agent.js';
import type {
  ContinueOptions,
  SendOptions,
  SessionEvent,
  SessionManager,
  SessionManagerOptions,
  SessionTurn,
} from '../definitions/manager.js';
import type {
  PendingInput,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from '../definitions/session.js';
import type { SessionStore } from '../definitions/store.js';
import type { InputResponses } from '../turns/pending-input.js';
import type { LiveSession, ReadySession } from './live-session.js';

import { SessionCapacityError } from '../errors/session-capacity-error.js';
import { SessionConflictError } from '../errors/session-conflict-error.js';
import { SessionNotFoundError } from '../errors/session-not-found-error.js';
import { createMemorySessionStore } from '../store/memory-session-store.js';
import {
  describeResponses,
  pendingInputOf,
  responsesFrom,
  withResponses,
} from '../turns/pending-input.js';
import { streamTurn } from '../turns/turn-stream.js';
import {
  isLive,
  isReady,
  liveSession,
  messageOf,
  newRecord,
  summaryOf,
  textOf,
} from './live-session.js';
import { SessionJournal } from './session-journal.js';

const INTERRUPTED_BY_CRASH = 'The application stopped without suspending the session.';
const CUT_BY_SHUTDOWN = 'The turn was cut short: the application stopped. Send the message again.';
const FAILED_BY_SHUTDOWN = 'The application stopped before the session was ready.';
const NOT_STOPPED = 'The harness session could not be stopped cleanly.';
const NOTHING_TO_RESUME = 'Nothing was kept to resume the session from.';
/** How long a shutdown waits for a turn it cut short to wind down. */
const WIND_DOWN_MS = 10_000;

/** The answers `continue()` was given: read from `useChat`'s message, and given as they are. */
function responsesOf(
  pending: PendingInput,
  { message, ...given }: Omit<ContinueOptions, 'abortSignal'>,
): InputResponses {
  const read = message === undefined ? undefined : responsesFrom(message, pending);
  return {
    toolApprovalContinuations: [
      ...(read?.toolApprovalContinuations ?? []),
      ...(given.toolApprovalContinuations ?? []),
    ],
    toolResultContinuations: [
      ...(read?.toolResultContinuations ?? []),
      ...(given.toolResultContinuations ?? []),
    ],
  };
}

/**
 * The resume state without the turn it was suspended in. `HarnessAgentSession.stop()` leaves the
 * bridge of an unfinished turn running, for a later process to reattach to it, and its state
 * points at that bridge (`data.bridge` for Claude Code and Codex); a suspension then stops it.
 * Resumed with it, a harness would try to reach that bridge until its startup timeout, two
 * minutes, before starting another one: without it, the harness session resumes at once.
 */
function withoutUnfinishedTurn(
  state: HarnessAgentResumeSessionState,
): HarnessAgentResumeSessionState {
  if (state.continueFrom === undefined) return state;
  const { continueFrom: _lost, data, ...resumable } = state;
  const { bridge: _stopped, ...kept } = (data ?? {}) as Record<string, JSONValue>;
  return { ...resumable, data: kept };
}

interface TransitionOptions {
  error?: string;
  /** Write the change to the store. Default: `true`. */
  persist?: boolean;
  /** What a suspended session resumes from. */
  resumeState?: HarnessAgentResumeSessionState;
}

/** The options with their defaults. */
type Settings<METADATA> = Required<
  Omit<SessionManagerOptions<METADATA>, 'agent' | 'sandboxes' | 'store'>
>;

const defaultReport = (
  error: unknown,
  { action, sessionId }: { action: string; sessionId?: string },
) =>
  // eslint-disable-next-line no-console -- the default, until the application passes onError
  console.error(`ai-sdk-harness-sessions: ${action}${sessionId ? ` ${sessionId}` : ''}:`, error);

/**
 * Manages the sessions of an application with its coding agents, `HarnessAgent`s of any harness:
 *
 * 1. `create()` opens a session, `preparing` while its sandbox and harness session open.
 * 2. `send()` streams a turn in reply to a message, `busy` meanwhile; one turn at a time.
 * 3. A turn that pauses on a tool approval, or on a tool your application runs, leaves the session
 *    `awaiting-input` until `continue()`.
 * 4. A session idle for `idleTimeoutMs` is `suspended`: its harness session stops, its state is
 *    kept in the store, its sandbox freed. The next message brings it back where it was.
 * 5. `shutdown()` suspends every live session, so the next start of the application resumes them;
 *    a session the process left live without it is `interrupted` at the next start.
 * 6. `close()` ends a session for good.
 *
 * Every change is written to the store and sent to the subscribers. Keep one manager per store:
 * a second one would take the sessions of the first for those of a crashed process.
 */
export function createSessionManager<METADATA = unknown>(
  options: SessionManagerOptions<METADATA>,
): SessionManager<METADATA> {
  return new HarnessSessionManager(options);
}

class HarnessSessionManager<METADATA> implements SessionManager<METADATA> {
  private readonly store: SessionStore<METADATA>;
  private readonly settings: Settings<METADATA>;
  private readonly journal: SessionJournal<METADATA>;
  private readonly live = new Map<string, LiveSession<METADATA>>();
  /** Starts run one at a time: the first one installs the harness in the sandbox. */
  private starting: Promise<unknown> = Promise.resolve();
  private readonly recovered: Promise<void>;
  private readonly sweeper: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: SessionManagerOptions<METADATA>) {
    this.store = options.store ?? createMemorySessionStore<METADATA>();
    this.settings = {
      idleTimeoutMs: options.idleTimeoutMs ?? 0,
      closeSuspendedAfterMs: options.closeSuspendedAfterMs ?? 0,
      turnTimeoutMs: options.turnTimeoutMs ?? 0,
      suspendIdleWhenFull: options.suspendIdleWhenFull ?? true,
      generateId: options.generateId ?? randomUUID,
      errorMessage: options.errorMessage ?? getHarnessErrorMessage,
      onError: options.onError ?? defaultReport,
    };
    this.journal = new SessionJournal(this.store, this.report);
    this.recovered = this.recover().catch(this.report('recover'));
    const { closeSuspendedAfterMs } = this.settings;
    if (closeSuspendedAfterMs > 0) {
      this.sweeper = setInterval(
        () => void this.sweep().catch(this.report('sweep')),
        Math.min(closeSuspendedAfterMs, 60_000),
      );
      this.sweeper.unref();
    }
  }

  create = async ({
    id = this.settings.generateId(),
    metadata,
  }: {
    id?: string;
    metadata: METADATA;
  }): Promise<SessionSummary<METADATA>> => {
    await this.ready();
    const existing = this.live.get(id)?.record ?? (await this.store.get(id));
    if (existing !== undefined) throw this.conflict(existing, `A session ${id} already exists.`);
    await this.makeRoom();
    const session = liveSession(newRecord(id, metadata));
    this.live.set(id, session);
    await this.transition(session, 'preparing');
    session.ready = this.start(session);
    session.ready.catch(() => undefined);
    return summaryOf(session.record);
  };

  get = async (id: string): Promise<SessionRecord<METADATA> | undefined> => {
    await this.recovered;
    const session = this.live.get(id);
    return session === undefined ? this.store.get(id) : structuredClone(session.record);
  };

  list = async (): Promise<SessionSummary<METADATA>[]> => {
    await this.recovered;
    const kept = await this.store.list();
    const ids = new Set(kept.map(({ id }) => id));
    const live = [...this.live.values()].filter(({ record }) => !ids.has(record.id));
    return [
      ...kept.map((summary) => {
        const session = this.live.get(summary.id);
        return session === undefined ? summary : summaryOf(session.record);
      }),
      ...live.map(({ record }) => summaryOf(record)),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  send = async (
    id: string,
    { message, prompt, abortSignal }: SendOptions,
  ): Promise<SessionTurn<METADATA>> => {
    await this.ready();
    const session = await this.openSession(id);
    this.claim(session, 'idle');
    const userMessage: UIMessage =
      typeof message === 'string'
        ? { id: this.settings.generateId(), role: 'user', parts: [{ type: 'text', text: message }] }
        : message;
    const { record } = session;
    record.messages = [
      ...record.messages.filter(({ id: kept }) => kept !== userMessage.id),
      userMessage,
    ];
    const text = prompt ?? textOf(userMessage);
    return this.runTurn(
      session,
      (signal) =>
        session.agent.stream({ session: session.handle, prompt: text, abortSignal: signal }),
      abortSignal,
    );
  };

  continue = async (
    id: string,
    { abortSignal, ...answers }: ContinueOptions,
  ): Promise<SessionTurn<METADATA>> => {
    await this.ready();
    const session = await this.openSession(id);
    this.claim(session, 'awaiting-input');
    const { record } = session;
    const pending = record.pendingInput ?? pendingInputOf(record.messages);
    const responses = responsesOf(pending, answers);
    if (
      responses.toolApprovalContinuations.length + responses.toolResultContinuations.length ===
      0
    ) {
      throw this.conflict(record, 'continue() carries no answer to what the session waits for.');
    }
    record.messages = withResponses(record.messages, responses);
    delete record.pendingInput;
    // A turn lost with a suspension cannot continue: the agent is told the answers instead.
    const prompt = session.lostTurn === true ? describeResponses(pending, responses) : undefined;
    session.lostTurn = false;
    return this.runTurn(
      session,
      (signal) =>
        prompt === undefined
          ? session.agent.continueStream({
              session: session.handle,
              ...responses,
              abortSignal: signal,
            })
          : session.agent.stream({ session: session.handle, prompt, abortSignal: signal }),
      abortSignal,
    );
  };

  interrupt = async (id: string): Promise<void> => {
    await this.recovered;
    const session = this.live.get(id);
    if (session === undefined && (await this.store.get(id)) === undefined) {
      throw new SessionNotFoundError(id);
    }
    const turn = session?.turn;
    if (turn === undefined) return;
    turn.abort.abort(new Error('The turn was interrupted.'));
    await turn.done;
  };

  suspend = async (id: string): Promise<SessionSummary<METADATA>> => {
    await this.ready();
    const session = this.live.get(id);
    if (session === undefined) {
      const kept = await this.store.get(id);
      if (kept === undefined) throw new SessionNotFoundError(id);
      if (kept.status === 'suspended') return summaryOf(kept);
      throw this.conflict(kept);
    }
    await session.ready.catch(() => undefined);
    const { status } = session.record;
    if (this.live.get(id) !== session || (status !== 'idle' && status !== 'awaiting-input')) {
      throw this.conflict(session.record);
    }
    await this.park(session);
    return summaryOf(session.record);
  };

  close = async (id: string): Promise<SessionSummary<METADATA>> => {
    await this.ready();
    const session = this.live.get(id);
    await session?.ready.catch(() => undefined);
    if (session !== undefined && this.live.get(id) === session) {
      this.live.delete(id);
      session.turn?.abort.abort(new Error('The session was closed.'));
      await session.turn?.done;
      await this.teardown(session);
      delete session.record.pendingInput;
      await this.transition(session, 'closed');
      return summaryOf(session.record);
    }
    const kept = await this.store.get(id);
    if (kept === undefined) throw new SessionNotFoundError(id);
    return this.closeKept(kept);
  };

  delete = async (id: string): Promise<void> => {
    await this.close(id);
    await this.journal.delete(id);
  };

  subscribe = (listener: (event: SessionEvent<METADATA>) => void): (() => void) =>
    this.journal.subscribe(listener);

  shutdown = async (): Promise<void> => {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.live.values()].map((session) => this.shutdownSession(session)));
    await this.options.sandboxes.shutdown?.().catch(this.report('shutdown'));
    await this.journal.flush();
  };

  private readonly report =
    (action: string, sessionId?: string) =>
    (error: unknown): void =>
      this.settings.onError(error, { action, ...(sessionId !== undefined && { sessionId }) });

  private async ready(): Promise<void> {
    if (this.stopped) throw new Error('The session manager is shut down.');
    await this.recovered;
  }

  /**
   * A session still live in the store was live when the application last stopped without
   * suspending it: it cannot be brought back.
   */
  private async recover(): Promise<void> {
    for (const { id, status } of await this.store.list()) {
      if (!isLive(status)) continue;
      const record = await this.store.get(id);
      if (record === undefined) continue;
      await this.transition(liveSession(record), 'interrupted', { error: INTERRUPTED_BY_CRASH });
    }
  }

  /** The one place a session changes status: it is written, unless told not to, and sent out. */
  private transition(
    session: LiveSession<METADATA>,
    status: SessionStatus,
    { error, persist = true, resumeState }: TransitionOptions = {},
  ): Promise<void> {
    const { record } = session;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (error === undefined) delete record.error;
    else record.error = error;
    this.journal.updated(record);
    return persist ? this.journal.write(record, resumeState) : Promise.resolve();
  }

  private conflict(record: SessionSummary<METADATA>, message?: string): SessionConflictError {
    const said =
      message ?? `The session is ${record.status}${record.error ? `: ${record.error}` : ''}.`;
    return new SessionConflictError(record.id, record.status, said);
  }

  /** Makes room for one more live session, suspending the one idle the longest if need be. */
  private async makeRoom(): Promise<void> {
    const { capacity } = this.options.sandboxes;
    if (capacity === undefined || this.live.size < capacity) return;
    const idle = [...this.live.values()]
      .filter(({ record }) => record.status === 'idle')
      .sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt))[0];
    if (!this.settings.suspendIdleWhenFull || idle === undefined) {
      throw new SessionCapacityError(capacity);
    }
    await this.park(idle);
  }

  private scheduleIdle(session: LiveSession<METADATA>): void {
    clearTimeout(session.idleTimer);
    const { idleTimeoutMs } = this.settings;
    if (idleTimeoutMs <= 0) return;
    session.idleTimer = setTimeout(() => {
      const { id, status } = session.record;
      if (this.live.get(id) !== session || (status !== 'idle' && status !== 'awaiting-input')) {
        return;
      }
      void this.park(session).catch(this.report('suspend', id));
    }, idleTimeoutMs);
    session.idleTimer.unref();
  }

  /**
   * Readies the session, one at a time: its agent, its sandbox and a new harness session, or the
   * one it had, resumed.
   */
  private start(
    session: LiveSession<METADATA>,
    resumeFrom?: HarnessAgentResumeSessionState,
  ): Promise<void> {
    const started = this.starting.then(async () => {
      try {
        await this.open(session, resumeFrom);
      } catch (error) {
        await this.startFailed(session, error, resumeFrom);
        throw error;
      }
      const { id } = session.record;
      if (this.live.get(id) !== session) {
        // Closed, or the application stopped, while it started.
        await (resumeFrom === undefined ? this.teardown(session) : this.park(session));
        return;
      }
      session.resuming = false;
      const unfinished = session.handle?.hasUnfinishedTurn() === true;
      // Resumed without the turn it waited in: it still waits for the answers.
      session.lostTurn = !unfinished && session.record.pendingInput !== undefined;
      const waiting = unfinished || session.lostTurn;
      await this.transition(session, waiting ? 'awaiting-input' : 'idle');
      this.scheduleIdle(session);
    });
    this.starting = started.catch(() => undefined);
    return started;
  }

  private async open(
    session: LiveSession<METADATA>,
    resumeFrom: HarnessAgentResumeSessionState | undefined,
  ): Promise<void> {
    const { id, metadata } = session.record;
    const agent = await this.options.agent({ id, metadata });
    session.agent = agent;
    const lease = await this.options.sandboxes.acquire(id, { resume: resumeFrom !== undefined });
    session.lease = lease;
    session.handle = await agent.createSession({
      sessionId: id,
      sandboxSession: lease.sandboxSession,
      ...(resumeFrom !== undefined && { resumeFrom }),
    });
  }

  private async startFailed(
    session: LiveSession<METADATA>,
    error: unknown,
    resumeFrom: HarnessAgentResumeSessionState | undefined,
  ): Promise<void> {
    const { id } = session.record;
    this.report(resumeFrom === undefined ? 'start' : 'resume', id)(error);
    if (this.live.get(id) === session) this.live.delete(id);
    await this.teardown(session);
    // A resume that failed keeps what it resumes from: the next message tries again.
    await (resumeFrom === undefined
      ? this.transition(session, 'failed', { error: messageOf(error) })
      : this.transition(session, 'suspended', {
          error: messageOf(error),
          resumeState: resumeFrom,
        }));
  }

  /** Stops the harness session for good, and hands its sandbox back. */
  private async teardown(session: LiveSession<METADATA>): Promise<void> {
    const { handle, lease, record } = session;
    session.handle = undefined;
    session.lease = undefined;
    clearTimeout(session.idleTimer);
    await handle?.destroy().catch(this.report('destroy', record.id));
    await lease?.close().catch(this.report('close', record.id));
  }

  /**
   * Suspends the session: its harness session stops, keeping what it needs to resume, and its
   * sandbox is freed.
   */
  private async park(session: LiveSession<METADATA>, error?: string): Promise<void> {
    const { id } = session.record;
    clearTimeout(session.idleTimer);
    if (this.live.get(id) === session) this.live.delete(id);
    const { handle, lease } = session;
    session.handle = undefined;
    session.lease = undefined;
    const resumeState = await handle?.stop().catch((stopError: unknown) => {
      this.report('stop', id)(stopError);
      return undefined;
    });
    await lease?.suspend().catch(this.report('suspend', id));
    await (resumeState === undefined
      ? this.transition(session, 'interrupted', { error: NOT_STOPPED })
      : this.transition(session, 'suspended', {
          ...(error !== undefined && { error }),
          resumeState,
        }));
  }

  /** The live session `id`, ready for a turn: a suspended one is resumed, a failed one started. */
  private async openSession(id: string): Promise<ReadySession<METADATA>> {
    let session = this.live.get(id);
    if (session === undefined) {
      const kept = await this.store.get(id);
      if (kept === undefined) throw new SessionNotFoundError(id);
      if (kept.status !== 'suspended' && kept.status !== 'failed') throw this.conflict(kept);
      session = await this.revive(kept);
    }
    await session.ready.catch(() => undefined);
    if (this.live.get(id) !== session || !isReady(session)) throw this.conflict(session.record);
    return session;
  }

  /**
   * Brings a kept session back: `preparing` while it resumes, or starts again when it failed to
   * start. The store keeps a resuming session `suspended` until it is back, so a crash meanwhile
   * leaves it resumable.
   */
  private async revive(kept: SessionRecord<METADATA>): Promise<LiveSession<METADATA>> {
    await this.makeRoom();
    const resuming = kept.status === 'suspended';
    const resumeState = resuming ? await this.store.getResumeState(kept.id) : undefined;
    // Another call may have brought it back while this one waited.
    const racing = this.live.get(kept.id);
    if (racing !== undefined) return racing;
    const session = liveSession(kept, resuming);
    if (resuming && resumeState === undefined) {
      await this.transition(session, 'interrupted', { error: NOTHING_TO_RESUME });
      throw this.conflict(session.record);
    }
    this.live.set(kept.id, session);
    await this.transition(session, 'preparing', { persist: !resuming });
    session.ready = this.start(session, resumeState && withoutUnfinishedTurn(resumeState));
    session.ready.catch(() => undefined);
    return session;
  }

  /** Throws unless the session is `from`: one turn at a time. */
  private claim(session: LiveSession<METADATA>, from: SessionStatus): void {
    const { record } = session;
    if (record.status === from) return;
    const messages: Partial<Record<SessionStatus, string>> = {
      'awaiting-input': 'The session waits for input: answer it with continue() first.',
      idle: 'The session waits for no input: send it a message.',
    };
    throw this.conflict(record, messages[record.status]);
  }

  /** Runs one turn of the session; it settles once its stream is over. */
  private async runTurn(
    session: ReadySession<METADATA>,
    begin: (abortSignal: AbortSignal) => PromiseLike<SessionStreamResult>,
    callerSignal: AbortSignal | undefined,
  ): Promise<SessionTurn<METADATA>> {
    const { handle } = session;
    clearTimeout(session.idleTimer);
    const abort = new AbortController();
    const { turnTimeoutMs, generateId, errorMessage } = this.settings;
    const timer =
      turnTimeoutMs > 0
        ? setTimeout(() => abort.abort(new Error('The turn took too long.')), turnTimeoutMs)
        : undefined;
    let finish!: () => void;
    session.turn = { abort, done: new Promise((resolve) => (finish = resolve)) };
    await this.transition(session, 'busy');
    const settle = async (failure?: string): Promise<void> => {
      clearTimeout(timer);
      await this.settleTurn(session, handle, failure);
      finish();
    };

    let result: SessionStreamResult;
    try {
      result = await begin(
        callerSignal ? AbortSignal.any([abort.signal, callerSignal]) : abort.signal,
      );
    } catch (error) {
      await settle(messageOf(error));
      throw error;
    }
    const { record } = session;
    const { stream, settled } = streamTurn(result, {
      originalMessages: record.messages,
      generateMessageId: generateId,
      errorMessage,
      onSettled: async ({ messages, failure, usage }) => {
        if (messages !== undefined) record.messages = messages;
        record.turns += 1;
        record.usage.inputTokens += usage?.inputTokens ?? 0;
        record.usage.outputTokens += usage?.outputTokens ?? 0;
        record.usage.totalTokens += usage?.totalTokens ?? 0;
        await settle(failure);
      },
    });
    const done = settled.then(() => summaryOf(record));
    done.catch(() => undefined);
    return {
      stream,
      toUIMessageStreamResponse: (init) => createUIMessageStreamResponse({ ...init, stream }),
      done,
    };
  }

  /** After a turn: awaiting input if it paused, idle otherwise. */
  private async settleTurn(
    session: LiveSession<METADATA>,
    handle: HarnessAgentSession,
    failure: string | undefined,
  ): Promise<void> {
    session.turn = undefined;
    const { record } = session;
    // Closed, suspended or shut down meanwhile: whoever did it writes the session.
    if (this.live.get(record.id) !== session || record.status !== 'busy') return;
    const unfinished = handle.hasUnfinishedTurn();
    if (unfinished) record.pendingInput = pendingInputOf(record.messages);
    else delete record.pendingInput;
    await this.transition(session, unfinished ? 'awaiting-input' : 'idle', {
      ...(failure !== undefined && { error: failure }),
    });
    this.scheduleIdle(session);
  }

  private async closeKept(kept: SessionRecord<METADATA>): Promise<SessionSummary<METADATA>> {
    if (kept.status === 'closed') return summaryOf(kept);
    if (kept.status === 'suspended') {
      await this.options.sandboxes.discard?.(kept.id).catch(this.report('discard', kept.id));
    }
    const session = liveSession(kept);
    delete session.record.pendingInput;
    await this.transition(session, 'closed');
    return summaryOf(session.record);
  }

  /** Closes the sessions suspended for `closeSuspendedAfterMs`. */
  private async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - this.settings.closeSuspendedAfterMs).toISOString();
    for (const { id, status, updatedAt } of await this.store.list()) {
      if (status !== 'suspended' || updatedAt >= cutoff || this.live.has(id)) continue;
      const kept = await this.store.get(id);
      if (kept?.status === 'suspended' && !this.live.has(id)) await this.closeKept(kept);
    }
  }

  /** Suspends a live session for the shutdown, cutting its turn short. */
  private async shutdownSession(session: LiveSession<METADATA>): Promise<void> {
    const { record } = session;
    if (record.status === 'preparing') {
      // Its start finds it gone and cleans up after itself; a resume parks it again.
      this.live.delete(record.id);
      await session.ready.catch(() => undefined);
      if (!session.resuming && record.status === 'preparing') {
        await this.transition(session, 'failed', { error: FAILED_BY_SHUTDOWN });
      }
      return;
    }
    const { turn } = session;
    if (turn !== undefined) {
      turn.abort.abort(new Error(CUT_BY_SHUTDOWN));
      await Promise.race([
        turn.done,
        new Promise((resolve) => setTimeout(resolve, WIND_DOWN_MS).unref()),
      ]);
    }
    await this.park(session, turn === undefined ? undefined : CUT_BY_SHUTDOWN);
  }
}
