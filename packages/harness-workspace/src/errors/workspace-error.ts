/** What `isInstance` looks for, shared by every copy of this package. */
const MARKER: unique symbol = Symbol.for('ai-sdk-harness-workspace.WorkspaceError');

/**
 * A step of the workspace failed in the sandbox: fetching the repository, checking it out, reading
 * the changes. `stderr` holds what git said.
 */
export class WorkspaceError extends Error {
  private readonly [MARKER] = true;

  constructor(
    message: string,
    /** The step that failed: `fetch`, `checkout`, `changes`… */
    readonly step: string,
    /** What the failed command wrote on its standard error, when a command failed. */
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }

  /**
   * Whether `error` is one, a {@link WorkspaceLostError} or a {@link WorkspaceSetupError}
   * included, rather than `instanceof`: a bundler may load this package twice — Next.js does, for
   * a route and a page —, each copy with its own class.
   */
  static isInstance(error: unknown): error is WorkspaceError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
