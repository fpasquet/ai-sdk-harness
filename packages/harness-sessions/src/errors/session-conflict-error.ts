import type { SessionStatus } from '../definitions/session.js';

/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-sessions.SessionConflictError');

/**
 * The session cannot do this in its status: a message while a turn is under way (`busy`) or while
 * it waits for input (`awaiting-input`), `continue()` when it waits for nothing, anything once it
 * is `closed` or `interrupted`. An HTTP API answers 409.
 */
export class SessionConflictError extends Error {
  private readonly [MARKER] = true;

  constructor(
    readonly sessionId: string,
    /** The session's status when it refused. */
    readonly status: SessionStatus,
    message: string,
  ) {
    super(message);
    this.name = 'SessionConflictError';
  }

  /** Whether `error` is one, whichever copy of the package threw it. */
  static isInstance(error: unknown): error is SessionConflictError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
