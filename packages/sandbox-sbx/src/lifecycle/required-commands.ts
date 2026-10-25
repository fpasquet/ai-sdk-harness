import type { SbxCli } from '../transport/sbx-cli.js';

import { SbxSandboxImageError } from '../errors/sbx-sandbox-image-error.js';

/** What a harness needs in any sandbox: Node.js for its bridge, git for the repositories. */
export const DEFAULT_REQUIRED_COMMANDS: readonly string[] = ['node', 'git'];

/** Prints each of its arguments that is not a command of the sandbox. */
const MISSING = 'for c in "$@"; do command -v "$c" >/dev/null 2>&1 || printf "%s\\n" "$c"; done';

/**
 * Checks that the sandbox `name` has `commands`, after its setup and before the harness: a missing
 * one would otherwise fail far later, in the middle of the harness's bootstrap.
 */
export async function assertRequiredCommands(
  cli: SbxCli,
  name: string,
  { commands, abortSignal }: { commands: readonly string[]; abortSignal?: AbortSignal },
): Promise<void> {
  if (commands.length === 0) return;
  const stdout = await cli.check(['exec', name, 'sh', '-c', MISSING, 'sh', ...commands], {
    abortSignal,
  });
  const missing = stdout.split('\n').filter(Boolean);
  if (missing.length > 0) throw new SbxSandboxImageError(name, missing);
}
