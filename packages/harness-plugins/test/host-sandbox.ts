import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A stand-in sandbox for the tests: it runs on this host, in a temporary directory, and isolates
 * nothing. What it records is every command it ran.
 */
export interface HostSandbox {
  session: SandboxSession;
  directory: string;
  commands: string[];
}

const notImplemented = (): never => {
  throw new Error('Not used by the plugins.');
};

export async function createHostSandbox(): Promise<HostSandbox> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-plugins-'));
  const commands: string[] = [];
  const session: SandboxSession = {
    description: 'A temporary directory on this host.',
    run: ({ command, workingDirectory, env = {} }) => {
      commands.push(command);
      return new Promise((resolve) => {
        execFile(
          'sh',
          ['-c', command],
          { cwd: workingDirectory ?? directory, env: { ...process.env, ...env } },
          (error, stdout, stderr) =>
            resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr }),
        );
      });
    },
    readTextFile: async ({ path }) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    writeTextFile: async ({ path, content }) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    readFile: notImplemented,
    readBinaryFile: notImplemented,
    writeFile: notImplemented,
    writeBinaryFile: notImplemented,
    spawn: notImplemented,
  };
  return { session, directory, commands };
}
