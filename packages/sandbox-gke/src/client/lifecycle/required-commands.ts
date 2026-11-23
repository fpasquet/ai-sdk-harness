import type { GkeNetworkSandboxSession } from '../session/gke-network-sandbox-session.js';

import { GkeSandboxImageError } from '../errors/gke-sandbox-image-error.js';

/** What a harness needs in any sandbox: Node.js for its bridge, git for the repositories. */
export const DEFAULT_REQUIRED_COMMANDS: readonly string[] = ['node', 'git'];

/** Prints each of its arguments that is not a command of the sandbox. */
const MISSING = 'for c in "$@"; do command -v "$c" >/dev/null 2>&1 || printf "%s\\n" "$c"; done';

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Checks that the sandbox has `commands` once its setup ran, which may install them: a missing one
 * would otherwise fail far later, in the middle of the harness's bootstrap.
 */
export async function assertRequiredCommands(
  session: GkeNetworkSandboxSession,
  commands: readonly string[],
  abortSignal?: AbortSignal,
): Promise<void> {
  if (commands.length === 0) return;
  const { stdout } = await session.run({
    command: `sh -c ${quote(MISSING)} sh ${commands.map(quote).join(' ')}`,
    abortSignal,
  });
  const missing = stdout.split('\n').filter(Boolean);
  if (missing.length > 0) throw new GkeSandboxImageError(session.id, missing);
}
