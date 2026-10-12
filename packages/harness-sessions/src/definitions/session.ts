import type { UIMessage } from 'ai';

/**
 * Where a session stands in its lifecycle.
 *
 * - `preparing`: its sandbox and its harness session are being opened, or brought back from
 *   `suspended`. A message sent meanwhile waits for them.
 * - `idle`: ready for a message.
 * - `busy`: a turn is under way. One turn at a time: another message is refused until it ends.
 * - `awaiting-input`: the turn paused on a tool call that waits for you, a tool approval or the
 *   result of a tool your application runs. `continue()` resumes it.
 * - `suspended`: stopped while idle or awaiting input, its state kept in the store and its sandbox
 *   freed. The next message, or `continue()`, brings it back where it was.
 * - `closed`: ended for good. Its messages can still be read.
 * - `failed`: a new session that could not start. The next message tries again.
 * - `interrupted`: a session that cannot be brought back: the process stopped without suspending
 *   it, or resuming it failed. Its messages can still be read.
 */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Every status, in the order of the lifecycle. */
export const SESSION_STATUSES = [
  'preparing',
  'idle',
  'busy',
  'awaiting-input',
  'suspended',
  'closed',
  'failed',
  'interrupted',
] as const;

/**
 * The statuses of a session held in memory, with a harness session and a sandbox: what an
 * application that stops without suspending them loses.
 */
export const LIVE_STATUSES = [
  'preparing',
  'idle',
  'busy',
  'awaiting-input',
] as const satisfies readonly SessionStatus[];

/** The tokens a session's turns used, added up. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** An answer to an approval request, as `ToolApprovalResponse` carries it. */
export interface ApprovalVerdict {
  approved: boolean;
  /** Why: what the agent is told of a denial, what a person reads of an automatic approval. */
  reason?: string;
}

/** A tool call the agent asked approval for, waiting for your answer. */
export interface PendingApproval {
  /** What the answer refers to: `ToolApprovalResponse.approvalId`. */
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /**
   * The answer the manager's `approve` option gave already, when it gave one: the turn waits for
   * the answers to the other approvals, and `continue()` sends this one with them.
   */
  decision?: ApprovalVerdict;
}

/** A tool call whose result your application gives, waiting for it. */
export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** What a session `awaiting-input` waits for. */
export interface PendingInput {
  approvals: PendingApproval[];
  toolCalls: PendingToolCall[];
}

/** A session as a list shows it: everything but its messages. */
export interface SessionSummary<METADATA = unknown> {
  id: string;
  status: SessionStatus;
  /** What your application keeps with the session: the agent it runs, a title, an owner… */
  metadata: METADATA;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601: the last change of status, or the end of the last turn. */
  updatedAt: string;
  /** The turns that reached their end. */
  turns: number;
  usage: SessionUsage;
  /** What went wrong last: a turn that failed, a start or a resume that could not happen. */
  error?: string;
  /** What the session waits for, while `awaiting-input` or suspended from there. */
  pendingInput?: PendingInput;
}

/** A session with its conversation, as `useChat` shows it. */
export interface SessionRecord<METADATA = unknown> extends SessionSummary<METADATA> {
  messages: UIMessage[];
}
