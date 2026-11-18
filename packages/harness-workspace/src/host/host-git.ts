import { spawn } from 'node:child_process';

import { WorkspaceError } from '../errors/workspace-error.js';

/**
 * Runs git on this host, in the repository at `path`, with none of its hooks nor its file-system
 * monitor: what a sandbox sent is never run here. Its standard output, trimmed; a failure throws a
 * `WorkspaceError` of `step`.
 */
export function hostGit(
  path: string,
  args: readonly string[],
  { input, step }: { input?: string; step: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', path, ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) =>
      reject(new WorkspaceError(`git could not run on this host: ${error.message}`, step)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim());
      else {
        const message = Buffer.concat(stderr).toString('utf8').trim();
        reject(
          new WorkspaceError(
            `git ${args[0]} failed on this host, in ${path} (exit ${code}): ${message}`,
            step,
            message,
          ),
        );
      }
    });
    // git may exit before it reads its input: the exit code says why, not the broken pipe.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Whether the repository at `path` on this host has `commit`. */
export function hostHasCommit(path: string, commit: string): Promise<boolean> {
  return hostGit(path, ['cat-file', '-e', `${commit}^{commit}`], { step: 'deliver' }).then(
    () => true,
    () => false,
  );
}
