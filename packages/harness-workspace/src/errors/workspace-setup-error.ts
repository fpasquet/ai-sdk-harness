import { WorkspaceError } from './workspace-error.js';

const MARKER: unique symbol = Symbol.for('ai-sdk-harness-workspace.WorkspaceSetupError');

/** A `setup` command failed in a new checkout: the session does not start. */
export class WorkspaceSetupError extends WorkspaceError {
  private readonly [MARKER] = true;

  constructor(
    /** The command that failed. */
    readonly command: string,
    /** Its exit code. */
    readonly exitCode: number,
    /** What it wrote, standard output then standard error. */
    readonly output: string,
  ) {
    super(
      `The setup command \`${command}\` failed (exit ${exitCode}): ${tail(output)}`,
      'setup',
      output,
    );
    this.name = 'WorkspaceSetupError';
  }

  /** Whether `error` is one, whichever copy of the package threw it. */
  static override isInstance(error: unknown): error is WorkspaceSetupError {
    return typeof error === 'object' && error !== null && MARKER in error;
  }
}

/** The end of a command's output, where it says what went wrong. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 2000 ? `…${trimmed.slice(-2000)}` : trimmed;
}
