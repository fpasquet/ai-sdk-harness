/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-sessions.SessionCapacityError');

/**
 * Every sandbox slot is taken: a new session, or a resume, has to wait for one to be suspended or
 * closed. An HTTP API answers 503.
 */
export class SessionCapacityError extends Error {
  private readonly [MARKER] = true;

  constructor(
    /** How many sessions may be live at once. */
    readonly capacity: number,
  ) {
    super(
      `${capacity} sessions are live, the most the sandboxes take: close or suspend one first.`,
    );
    this.name = 'SessionCapacityError';
  }

  /** Whether `error` is one, whichever copy of the package threw it. */
  static isInstance(error: unknown): error is SessionCapacityError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
