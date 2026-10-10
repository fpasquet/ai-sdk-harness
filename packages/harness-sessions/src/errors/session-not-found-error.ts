/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-sessions.SessionNotFoundError');

/** No session has this id. An HTTP API answers 404. */
export class SessionNotFoundError extends Error {
  private readonly [MARKER] = true;

  constructor(readonly sessionId: string) {
    super(`No session ${sessionId}.`);
    this.name = 'SessionNotFoundError';
  }

  /**
   * Whether `error` is one, rather than `instanceof`: a bundler may load this package twice —
   * Next.js does, for a route and a page —, each copy with its own class.
   */
  static isInstance(error: unknown): error is SessionNotFoundError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
