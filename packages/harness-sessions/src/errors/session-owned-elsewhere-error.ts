import type { SessionStatus } from '../definitions/session.js';

import { SessionConflictError } from './session-conflict-error.js';

/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-sessions.SessionOwnedElsewhereError');

/**
 * Another manager sharing the store runs the session: send the request to it — the instance
 * `owner` names —, or answer 409 and let the client try again. A `SessionConflictError` as well.
 */
export class SessionOwnedElsewhereError extends SessionConflictError {
  private readonly [MARKER] = true;

  constructor(
    sessionId: string,
    status: SessionStatus,
    /** The manager that runs the session: its `managerId`. */
    readonly owner: string,
  ) {
    super(sessionId, status, `The session ${sessionId} is run by another manager, ${owner}.`);
    this.name = 'SessionOwnedElsewhereError';
  }

  /** Whether `error` is one, whichever copy of the package threw it. */
  static override isInstance(error: unknown): error is SessionOwnedElsewhereError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
