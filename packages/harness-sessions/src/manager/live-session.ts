import type { HarnessAgentSession } from '@ai-sdk/harness/agent';
import type { UIMessage } from 'ai';

import type { SessionAgent } from '../definitions/agent.js';
import type { SessionSandboxLease } from '../definitions/sandboxes.js';
import type {
  PendingInput,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from '../definitions/session.js';

import { LIVE_STATUSES } from '../definitions/session.js';

/** A session held in memory, with its harness session and its sandbox once it started. */
export interface LiveSession<METADATA> {
  record: SessionRecord<METADATA>;
  agent?: SessionAgent;
  handle?: HarnessAgentSession;
  lease?: SessionSandboxLease;
  /** Settles once the session is ready for a turn, or failed to get there. */
  ready: Promise<void>;
  /** Whether it is coming back from `suspended`, rather than starting. */
  resuming: boolean;
  /**
   * Whether it was resumed without the turn it waited in, `awaiting-input`: `continue()` tells the
   * agent the answers in a message.
   */
  lostTurn?: boolean;
  /**
   * What the turn paused on, when the manager's `approve` answered part of it: the approvals with
   * the verdicts it gave, for the record.
   */
  paused?: PendingInput;
  turn?: { abort: AbortController; done: Promise<void> };
  /** Settles once a close, or a shutdown, that took the session over has written it. */
  ending?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
}

/** A live session that started: its agent and harness session are there. */
export type ReadySession<METADATA> = LiveSession<METADATA> & {
  agent: SessionAgent;
  handle: HarnessAgentSession;
};

/** Whether the session started: its agent and harness session are there. */
export const isReady = <METADATA>(
  session: LiveSession<METADATA>,
): session is ReadySession<METADATA> => session.agent !== undefined && session.handle !== undefined;

/** A session held in memory around a record: kept, or new. */
export const liveSession = <METADATA>(
  record: SessionRecord<METADATA>,
  resuming = false,
): LiveSession<METADATA> => ({ record, ready: Promise.resolve(), resuming });

/** A new session's record. */
export function newRecord<METADATA>(id: string, metadata: METADATA): SessionRecord<METADATA> {
  const now = new Date().toISOString();
  return {
    id,
    status: 'preparing',
    metadata,
    createdAt: now,
    updatedAt: now,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    messages: [],
  };
}

/** A copy of the session without its messages. */
export const summaryOf = <METADATA>({
  messages: _messages,
  ...summary
}: SessionRecord<METADATA>): SessionSummary<METADATA> => structuredClone(summary);

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The text of a user message, what the agent is sent when nothing else is said. */
export const textOf = (message: UIMessage): string =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

/** Whether a session in `status` is held in memory, with a harness session. */
export const isLive = (status: SessionStatus): boolean =>
  (LIVE_STATUSES as readonly SessionStatus[]).includes(status);
