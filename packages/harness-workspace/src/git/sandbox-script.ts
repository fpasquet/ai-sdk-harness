import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import { shellQuote } from '@ai-sdk/harness/utils';

import { WorkspaceError } from '../errors/workspace-error.js';

/**
 * Prepended to every script: git runs no hook and no file-system monitor of the repository's,
 * whatever an agent wrote in its configuration, and never stops to ask for a password.
 */
const PRELUDE = [
  'set -e',
  'export GIT_TERMINAL_PROMPT=0',
  'git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }',
].join('\n');

export interface Script {
  /** The script: what comes from outside is read from its positional parameters, `"$1"`… */
  script: string;
  args: readonly string[];
  /** Where it runs. Default: the sandbox's own working directory. */
  directory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/** Runs `script` with `sh -c` in the sandbox, its inputs as positional arguments, never spliced in. */
export async function runScript(
  sandbox: SandboxSession,
  { script, args, directory, env, abortSignal }: Script,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = ['sh', '-c', `${PRELUDE}\n${script}`, 'sh', ...args].map(shellQuote).join(' ');
  return sandbox.run({
    command,
    ...(directory !== undefined && { workingDirectory: directory }),
    ...(env !== undefined && { env }),
    ...(abortSignal !== undefined && { abortSignal }),
  });
}

/** {@link runScript}, its standard output trimmed; a non-zero exit throws a {@link WorkspaceError}. */
export async function checkScript(
  sandbox: SandboxSession,
  step: string,
  run: Script,
): Promise<string> {
  const result = await runScript(sandbox, run);
  if (result.exitCode !== 0) throw scriptError(step, result);
  return result.stdout.trim();
}

/** The error of a script that exited with a non-zero code during `step`. */
export function scriptError(
  step: string,
  { exitCode, stdout, stderr }: { exitCode: number; stdout: string; stderr: string },
): WorkspaceError {
  return new WorkspaceError(
    `The workspace's ${step} failed in the sandbox (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
    step,
    stderr,
  );
}
