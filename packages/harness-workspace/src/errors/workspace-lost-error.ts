import { WorkspaceError } from './workspace-error.js';

const MARKER: unique symbol = Symbol.for('ai-sdk-harness-workspace.WorkspaceLostError');

/**
 * A checkout of a suspended session is gone from its sandbox: the sandbox was removed, or its
 * files were. The session cannot resume where it was; close it and start another.
 */
export class WorkspaceLostError extends WorkspaceError {
  private readonly [MARKER] = true;

  constructor(
    readonly sessionId: string,
    /** The repository whose checkout is gone. */
    readonly repository?: string,
  ) {
    super(
      `The checkout${repository === undefined ? '' : ` of ${repository}`} of session ${sessionId} is gone from its sandbox.`,
      'reattach',
    );
    this.name = 'WorkspaceLostError';
  }

  /** Whether `error` is one, whichever copy of the package threw it. */
  static override isInstance(error: unknown): error is WorkspaceLostError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}
