import { SbxError } from './sbx-error.js';

/**
 * The `sbx` CLI is signed out of Docker, or its sign-in expired: nothing reaches a sandbox until
 * someone runs `sbx login` on this host. Thrown at once, without running `sbx`, by the next
 * commands of the same sandbox for a short while after it was first seen.
 */
export class SbxNotSignedInError extends SbxError {
  constructor(args: readonly string[], result: { exitCode: number; stderr: string }) {
    super(
      args,
      result,
      `\`sbx ${args[0] ?? ''}\` failed: Docker Sandboxes is signed out of Docker. ` +
        'Run `sbx login` on this host, then try again.',
    );
    this.name = 'SbxNotSignedInError';
  }
}
