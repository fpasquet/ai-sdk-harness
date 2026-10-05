/** An `sbx` command exited with a non-zero status. */
export class SbxError extends Error {
  /** The `sbx` sub-command and its arguments, as they were passed. */
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], result: { exitCode: number; stderr: string }) {
    super(`\`sbx ${args[0] ?? ''}\` exited with ${result.exitCode}: ${result.stderr.trim()}`);
    this.name = 'SbxError';
    this.args = args;
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}
