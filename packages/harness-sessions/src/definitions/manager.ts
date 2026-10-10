import type { ToolApprovalResponse, ToolResultPart, UIMessage, UIMessageChunk } from 'ai';

import type { SessionAgent } from './agent.js';
import type { SessionSandboxes } from './sandboxes.js';
import type { SessionRecord, SessionSummary } from './session.js';
import type { SessionStore } from './store.js';

export interface SessionManagerOptions<METADATA> {
  /**
   * The agent of a session, from its metadata: called when the session starts, and each time it
   * resumes, so a resumed session runs the agent as it stands then. Build each agent once and
   * return it again: a `HarnessAgent` is meant to be shared.
   */
  agent: (session: { id: string; metadata: METADATA }) => Promise<SessionAgent> | SessionAgent;
  /** How sessions get a sandbox: `sharedSandbox()`, `sandboxPerSession()`, or your own. */
  sandboxes: SessionSandboxes;
  /** Where sessions are kept. Default: in memory, `createMemorySessionStore()`. */
  store?: SessionStore<METADATA>;
  /**
   * Suspend a session idle, or awaiting input, for this long, in milliseconds: its harness session
   * stops, its state is kept and its sandbox freed. The next message brings it back. Default:
   * never.
   */
  idleTimeoutMs?: number;
  /** Close a session suspended for this long, in milliseconds. Default: never. */
  closeSuspendedAfterMs?: number;
  /** Cut a turn short after this long, in milliseconds. Default: never. */
  turnTimeoutMs?: number;
  /**
   * When every sandbox slot is taken, suspend the session idle the longest to make room for a new
   * one, or a resume, rather than refusing it with `SessionCapacityError`. Default: `true`.
   */
  suspendIdleWhenFull?: boolean;
  /** The ids of new sessions and of the messages of their turns. Default: `crypto.randomUUID`. */
  generateId?: () => string;
  /**
   * What a client is told of an error in a turn. Default: `getHarnessErrorMessage` of
   * `@ai-sdk/harness`. The session's `error` keeps the full message.
   */
  errorMessage?: (error: unknown) => string;
  /**
   * Called with what fails in the background: a start, a suspension, a write to the store. Default:
   * `console.error`.
   */
  onError?: (error: unknown, context: { action: string; sessionId?: string }) => void;
}

/** A user message: `useChat`'s last message, or its text. */
export interface SendOptions {
  message: string | UIMessage;
  /**
   * What the agent is sent, when it differs from what the conversation keeps: a slash command
   * expanded, for instance. Default: the text of `message`.
   */
  prompt?: string;
  /** Aborts the turn: the request's signal, so that the client's stop button stops it. */
  abortSignal?: AbortSignal;
}

/** The answers to what a session `awaiting-input` waits for. */
export interface ContinueOptions {
  /**
   * The last assistant message as `useChat` sends it back, once `addToolApprovalResponse()` or
   * `addToolOutput()` filled the answers in: they are read from it.
   */
  message?: UIMessage;
  toolApprovalContinuations?: readonly ToolApprovalResponse[];
  toolResultContinuations?: readonly ToolResultPart[];
  abortSignal?: AbortSignal;
}

/** A turn under way. */
export interface SessionTurn<METADATA = unknown> {
  /** The turn as a UI message stream, what `useChat` reads. */
  readonly stream: ReadableStream<UIMessageChunk>;
  /** {@link stream} as the response of a route handler. */
  toUIMessageStreamResponse(init?: ResponseInit): Response;
  /** The session once the turn is over and written: `idle`, or `awaiting-input`. */
  readonly done: Promise<SessionSummary<METADATA>>;
}

/** What happens to the sessions, for a list or a notification to follow. */
export type SessionEvent<METADATA = unknown> =
  | {
      /** The session changed: its status, or its conversation at the end of a turn. */
      type: 'updated';
      session: SessionSummary<METADATA>;
    }
  | { type: 'deleted'; sessionId: string };

/**
 * The sessions of an application with its coding agents: their whole lifecycle, from the first
 * message to the last, across suspensions and restarts. See {@link createSessionManager}.
 */
export interface SessionManager<METADATA = unknown> {
  /**
   * Opens a session and returns at once, `preparing`: its sandbox and its harness session are
   * opened in the background — minutes the very first time, when the harness is installed in the
   * sandbox. A message sent meanwhile waits for them.
   */
  create(options: { id?: string; metadata: METADATA }): Promise<SessionSummary<METADATA>>;
  /** The session with its conversation: a live one as it stands right now. */
  get(id: string): Promise<SessionRecord<METADATA> | undefined>;
  /** Every session, the most recently updated first. */
  list(): Promise<SessionSummary<METADATA>[]>;
  /**
   * Starts a turn in reply to a user message, resuming the session first when it is suspended, or
   * starting it again when it `failed`. One turn at a time: a session `busy` or `awaiting-input`
   * refuses it with `SessionConflictError`.
   */
  send(id: string, options: SendOptions): Promise<SessionTurn<METADATA>>;
  /**
   * Resumes the turn a session paused, `awaiting-input`, with the answers it waits for: approvals
   * of tool calls, results of tools your application runs. A session suspended meanwhile is
   * resumed first, its turn with it.
   */
  continue(id: string, options: ContinueOptions): Promise<SessionTurn<METADATA>>;
  /** Cuts the turn under way short, and resolves once the session is written. */
  interrupt(id: string): Promise<void>;
  /** Suspends a session idle or awaiting input, as idleness would. */
  suspend(id: string): Promise<SessionSummary<METADATA>>;
  /** Ends a session for good: its harness session and what it holds of its sandbox go. */
  close(id: string): Promise<SessionSummary<METADATA>>;
  /** Closes a session, then forgets it. */
  delete(id: string): Promise<void>;
  /** Calls `listener` with every change of every session; returns what unsubscribes it. */
  subscribe(listener: (event: SessionEvent<METADATA>) => void): () => void;
  /**
   * Suspends every live session, cutting turns under way short, so that the next start of the
   * application resumes them; then shuts the sandboxes down. Call it when the process is told to
   * stop. The manager refuses everything afterwards.
   */
  shutdown(): Promise<void>;
}
