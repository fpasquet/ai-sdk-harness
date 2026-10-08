/** A `sandbox` command exited with a non-zero status. */
export class SandboxCliError extends Error {
  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`\`sandbox ${args[0] ?? ''}\` exited with ${exitCode}: ${stderr.trim()}`);
    this.name = 'SandboxCliError';
  }
}
