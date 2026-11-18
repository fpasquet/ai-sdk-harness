import type { ApprovalVerdict } from '../definitions/policy.js';
import type { ToolCallSummary } from '../describe/describe-tool-call.js';
import type { PendingApprovalRequest } from '../policy/approval-policy.js';

import { describeToolCall } from '../describe/describe-tool-call.js';

/** Why a remote approval was given up before anyone answered it. */
export type AbandonReason =
  /** `abandon()` was called: answered on the server, or no longer wanted. */
  | 'abandoned'
  /** The caller's `abortSignal` aborted: the turn was interrupted, the session closed. */
  | 'aborted'
  /** `request` threw: the remote interface could not be reached. */
  | 'failed'
  /** Nobody answered within `timeoutMs`. */
  | 'timeout'
  /** `request` resolved without an answer. */
  | 'undecided';

/**
 * What happens to the approvals a {@link RemoteApprover} asks: plain JSON, to send as it is to
 * every interface that shows them — a browser, a phone —, so that one answered there is dismissed
 * elsewhere. `at` is an ISO 8601 time.
 */
export type RemoteApprovalEvent =
  | {
      type: 'abandoned';
      approvalId: string;
      reason: AbandonReason;
      at: string;
    }
  | {
      type: 'answered';
      approvalId: string;
      approved: boolean;
      /** Why, when the answer says. */
      reason?: string;
      at: string;
    }
  | {
      type: 'requested';
      approvalId: string;
      toolName: string;
      /** The input of the tool call, as the agent gave it. */
      input: unknown;
      /** What it does, in a few words: `describeToolCall()`. */
      summary: ToolCallSummary;
      at: string;
    };

/** An approval a {@link RemoteApprover} waits for: its `requested` event. */
export type RemoteApprovalRequest = Extract<RemoteApprovalEvent, { type: 'requested' }>;

/** What {@link remoteApprover} is given. */
export interface RemoteApproverOptions<CONTEXT> {
  /**
   * Asks a remote interface for the answer, and resolves with it: `{ approved, reason? }`, or
   * `undefined` to leave the approval undecided. `signal` aborts when the approval is abandoned
   * (`abandon()`, the caller's `abortSignal`, `timeoutMs`): withdraw the question then. An answer
   * given after it is ignored.
   */
  request: (
    request: RemoteApprovalRequest,
    options: { signal: AbortSignal; context: CONTEXT | undefined },
  ) => ApprovalVerdict | PromiseLike<ApprovalVerdict | undefined> | undefined;
  /** Gives up an approval nobody answered for this long, in milliseconds. Default: never. */
  timeoutMs?: number;
  /** Called with every event, as `subscribe()` listeners are. */
  onEvent?: (event: RemoteApprovalEvent) => void;
  /** The current time. Default: `() => new Date()`. */
  now?: () => Date;
}

/** Approvals answered from a remote interface: see {@link remoteApprover}. */
export interface RemoteApprover<CONTEXT> {
  /**
   * Asks for the approval of `request` through `request`, and resolves with the answer, or with
   * `undefined` once it is abandoned or unanswered: the `approve` option of `createSessionManager()`
   * of `ai-sdk-harness-sessions`, which then leaves the approval to a person. A context that
   * carries an `abortSignal` abandons the approval when it aborts.
   */
  approve: (
    request: PendingApprovalRequest,
    context?: CONTEXT,
  ) => Promise<ApprovalVerdict | undefined>;
  /** Gives up the approval `approvalId`, if it waits: `false` when it does not. */
  abandon: (approvalId: string) => boolean;
  /** The approvals waiting for an answer, the oldest first: what an interface shows as it connects. */
  pending: () => RemoteApprovalRequest[];
  /** Calls `listener` with every event; returns what unsubscribes it. */
  subscribe: (listener: (event: RemoteApprovalEvent) => void) => () => void;
}

interface Waiting {
  request: RemoteApprovalRequest;
  controller: AbortController;
}

const signalOf = (context: unknown): AbortSignal | undefined => {
  const signal = (context as null | undefined | { abortSignal?: unknown })?.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
};

/** The approvals a {@link remoteApprover} waits for, and those who follow them. */
class RemoteApprovals<CONTEXT> implements RemoteApprover<CONTEXT> {
  private readonly waiting = new Map<string, Waiting>();
  private readonly listeners = new Set<(event: RemoteApprovalEvent) => void>();
  private readonly now: () => Date;

  constructor(private readonly options: RemoteApproverOptions<CONTEXT>) {
    this.now = options.now ?? (() => new Date());
    if (options.onEvent !== undefined) this.listeners.add(options.onEvent);
  }

  approve = async (
    { approvalId, toolName, input }: PendingApprovalRequest,
    context?: CONTEXT,
  ): Promise<ApprovalVerdict | undefined> => {
    // The same approval asked twice is abandoned first: one wait per id.
    this.give(approvalId, 'abandoned');
    const entry = this.open({ approvalId, toolName, input });
    const callerSignal = signalOf(context);
    if (callerSignal?.aborted === true) {
      this.give(approvalId, 'aborted');
      return undefined;
    }
    const onAbort = () => this.give(approvalId, 'aborted');
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const { timeoutMs } = this.options;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => this.give(approvalId, 'timeout'), timeoutMs);
    try {
      return await this.ask(entry, context);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  };

  abandon = (approvalId: string): boolean => this.give(approvalId, 'abandoned');

  pending = (): RemoteApprovalRequest[] => [...this.waiting.values()].map(({ request }) => request);

  subscribe = (listener: (event: RemoteApprovalEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Waits for `approvalId` from now on, and tells it. */
  private open(call: PendingApprovalRequest): Waiting {
    const request: RemoteApprovalRequest = {
      type: 'requested',
      approvalId: call.approvalId,
      toolName: call.toolName,
      input: call.input,
      summary: describeToolCall(call),
      at: this.now().toISOString(),
    };
    const entry: Waiting = { request, controller: new AbortController() };
    this.waiting.set(call.approvalId, entry);
    this.emit(request);
    return entry;
  }

  /** The remote interface's answer, or `undefined` once the approval is abandoned. */
  private async ask(entry: Waiting, context: CONTEXT | undefined) {
    const { request, controller } = entry;
    const { approvalId } = request;
    const abandoned = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    let answer: ApprovalVerdict | undefined;
    try {
      answer = await Promise.race([
        Promise.resolve(this.options.request(request, { signal: controller.signal, context })),
        abandoned,
      ]);
    } catch (error) {
      if (this.waiting.get(approvalId) === entry) this.give(approvalId, 'failed');
      throw error;
    }
    if (this.waiting.get(approvalId) !== entry) return undefined;
    if (answer === undefined) {
      this.give(approvalId, 'undecided');
      return undefined;
    }
    const verdict: ApprovalVerdict = {
      approved: answer.approved,
      ...(answer.reason !== undefined && { reason: answer.reason }),
    };
    this.settle(approvalId, {
      type: 'answered',
      approvalId,
      ...verdict,
      at: this.now().toISOString(),
    });
    return verdict;
  }

  /** Gives up `approvalId`, if it waits. */
  private give(approvalId: string, reason: AbandonReason): boolean {
    const at = this.now().toISOString();
    return this.settle(approvalId, { type: 'abandoned', approvalId, reason, at });
  }

  /** Ends the wait for `approvalId`, once: `false` when it was over already. */
  private settle(approvalId: string, event: RemoteApprovalEvent): boolean {
    const entry = this.waiting.get(approvalId);
    if (entry === undefined) return false;
    this.waiting.delete(approvalId);
    if (event.type === 'abandoned') entry.controller.abort(new Error(`Approval ${event.reason}.`));
    this.emit(event);
    return true;
  }

  private emit(event: RemoteApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener that fails does not keep the others, nor the approval, from going on.
      }
    }
  }
}

/**
 * Approvals answered from a remote interface — a browser, a phone — while the turn waits: each
 * approval goes to `request`, which asks the interface and resolves with its answer. Every step is
 * an event, plain JSON (`requested`, `answered`, `abandoned`), for every interface to follow; an
 * approval may be abandoned — by `abandon()`, the caller's `abortSignal` or `timeoutMs` —, which
 * aborts the `signal` `request` holds.
 *
 * ```ts
 * const remote = remoteApprover({
 *   request: (approval, { signal }) => hub.ask(approval, { signal }), // your WebSocket, SSE…
 * });
 * createSessionManager({ approve: remote.approve, … });
 * ```
 */
export function remoteApprover<CONTEXT = unknown>(
  options: RemoteApproverOptions<CONTEXT>,
): RemoteApprover<CONTEXT> {
  return new RemoteApprovals(options);
}
