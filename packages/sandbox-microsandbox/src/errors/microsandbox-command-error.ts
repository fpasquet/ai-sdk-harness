/**
 * A command this package ran in the sandbox on its own behalf exited with a non-zero status: one
 * of the `setup` commands, or a step of the creation of the sandbox.
 */
export class MicrosandboxCommandError extends Error {
  /** The command and its arguments, as they were run. */
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(command: readonly string[], result: { exitCode: number; stderr: string }) {
    super(
      `\`${command.join(' ')}\` exited with ${result.exitCode} in the sandbox: ${result.stderr.trim()}`,
    );
    this.name = 'MicrosandboxCommandError';
    this.command = command;
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}
