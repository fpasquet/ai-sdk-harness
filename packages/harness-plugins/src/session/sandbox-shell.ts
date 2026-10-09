import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { shellQuote } from '@ai-sdk/harness/utils';

/**
 * Runs `script` in the sandbox, in `directory`, with `args` as its positional parameters: what
 * comes from a plugin is read as `"$1"`, never spliced into the script. Throws on a non-zero exit.
 */
export async function runScript(
  session: SandboxSession,
  { script, args, directory }: { script: string; args: readonly string[]; directory: string },
  abortSignal?: AbortSignal,
): Promise<void> {
  const command = ['sh', '-c', script, 'sh', ...args].map(shellQuote).join(' ');
  const result = await session.run({ command, workingDirectory: directory, abortSignal });
  if (result.exitCode !== 0) {
    throw new Error(
      `A plugin command failed in the sandbox (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

/** Removes the files given as arguments, then creates the directories after `--`. */
export const PREPARE = [
  'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do rm -f -- "$1"; shift; done',
  '[ "$#" -gt 0 ] && shift',
  'for dir in "$@"; do mkdir -p -- "$dir" || exit 1; done',
].join('\n');

/**
 * Makes the files given as arguments executable, then adds the paths after `--` to the
 * repository's `info/exclude` — when the directory is in a Git repository at all.
 */
export const FINISH = [
  'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do chmod +x -- "$1" || exit 1; shift; done',
  '[ "$#" -gt 0 ] && shift',
  'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0',
  'exclude=$(git rev-parse --git-path info/exclude) || exit 0',
  'prefix=$(git rev-parse --show-prefix)',
  'mkdir -p "$(dirname "$exclude")"',
  'for path in "$@"; do',
  '  line="/$prefix$path"',
  '  grep -qxF -- "$line" "$exclude" 2>/dev/null || printf "%s\\n" "$line" >> "$exclude"',
  'done',
].join('\n');
