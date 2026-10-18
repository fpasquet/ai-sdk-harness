import { SbxError } from './sbx-error.js';

/**
 * An `sbx` command did not finish within its deadline (`commandTimeoutMs`), and was killed: the
 * CLI or its daemon hangs, or the sandbox does not answer. `exitCode` is 124, as `timeout` reports.
 */
export class SbxTimeoutError extends SbxError {
  /** The deadline the command missed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(args: readonly string[], stderr: string, timeoutMs: number) {
    super(
      args,
      { exitCode: 124, stderr },
      `\`sbx ${args[0] ?? ''}\` did not finish within ${timeoutMs} ms and was stopped.`,
    );
    this.name = 'SbxTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
