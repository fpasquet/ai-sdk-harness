import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

/** A command the stand-in sandbox ran, with the variables it was given. */
export interface RanCommand {
  command: string;
  env: Record<string, string>;
}

/**
 * A stand-in sandbox for the tests: it runs on this host, in a temporary directory whose `home/`
 * is its user's home and `work/` its default working directory, and isolates nothing. It keeps
 * what it was asked: commands, files written, request transformations.
 */
export interface HostSandbox {
  sandbox: HarnessV1NetworkSandboxSession;
  directory: string;
  home: string;
  commands: RanCommand[];
  written: string[];
  transformations: HarnessV1RequestTransformation[];
}

const notImplemented = (): never => {
  throw new Error('Not used by the workspace.');
};

/** Git as the sandbox runs it: no configuration of this host's user, nor of the system. */
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export async function createHostSandbox(
  options: { brokering?: boolean } = {},
): Promise<HostSandbox> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-workspace-'));
  const home = join(directory, 'home');
  const work = join(directory, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  const record: Recorded = { commands: [], written: [], transformations: [] };
  const restricted = (): SandboxSession => hostSession({ home, work, record });
  const sandbox = {
    ...restricted(),
    id: 'host',
    defaultWorkingDirectory: work,
    ports: [],
    getPortEndpoint: notImplemented,
    getPortUrl: notImplemented,
    stop: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    restricted,
    ...(options.brokering !== false && {
      addRequestTransformations: (added: readonly HarnessV1RequestTransformation[]) => {
        record.transformations.push(...added);
        return Promise.resolve();
      },
    }),
  } as HarnessV1NetworkSandboxSession;
  return { sandbox, directory, home, ...record };
}

type Recorded = Pick<HostSandbox, 'commands' | 'transformations' | 'written'>;

/** The commands and files of the stand-in sandbox: on this host, `home` its user's home. */
function hostSession({
  home,
  work,
  record,
}: {
  home: string;
  work: string;
  record: Recorded;
}): SandboxSession {
  const write = async (path: string, content: Parameters<typeof writeFile>[1]) => {
    record.written.push(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  return {
    description: 'A temporary directory on this host.',
    run: ({ command, workingDirectory, env = {}, abortSignal }) => {
      record.commands.push({ command, env });
      return new Promise((resolve, reject) => {
        execFile(
          'sh',
          ['-c', command],
          {
            cwd: workingDirectory ?? work,
            env: { ...process.env, ...GIT_ENV, HOME: home, ...env },
            ...(abortSignal !== undefined && { signal: abortSignal }),
          },
          (error, stdout, stderr) => {
            if (error?.name === 'AbortError') {
              reject(new Error('The command was aborted.', { cause: error }));
              return;
            }
            resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
          },
        );
      });
    },
    readTextFile: async ({ path }) => readFile(path, 'utf8').catch(() => null),
    readBinaryFile: async ({ path }) =>
      readFile(path).then(
        (buffer) => new Uint8Array(buffer),
        () => null,
      ),
    writeTextFile: ({ path, content }) => write(path, content),
    writeBinaryFile: ({ path, content }) => write(path, content),
    writeFile: ({ path, content }) => write(path, Readable.fromWeb(content as never)),
    readFile: notImplemented,
    spawn: notImplemented,
  };
}

/** Runs git on this host, in `cwd`, as a person who commits would. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args],
      { cwd, env: { ...process.env, ...GIT_ENV } },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()),
    );
  });
}

/** A repository on this host with a few files and two commits on `main`: its path. */
export async function createSourceRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-workspace-source-'));
  await git(path, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(path, 'README.md'), '# Widgets\n');
  await writeFile(join(path, 'index.js'), 'export const answer = 41;\n');
  await writeFile(join(path, '.gitignore'), 'node_modules/\n');
  await git(path, 'add', '.');
  await git(path, 'commit', '--quiet', '-m', 'First');
  await writeFile(join(path, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(path, 'old.txt'), 'to be removed\n');
  await git(path, 'add', '.');
  await git(path, 'commit', '--quiet', '-m', 'Second');
  return path;
}

/**
 * What the harness does before `sandboxConfig.onSession`: makes the session's working directory,
 * `<defaultWorkingDirectory>/claude-code-<sessionId>`. Returns it.
 */
export async function sessionWorkDir(
  sandbox: HarnessV1NetworkSandboxSession,
  sessionId: string,
): Promise<string> {
  const path = join(sandbox.defaultWorkingDirectory, `claude-code-${sessionId}`);
  await mkdir(path, { recursive: true });
  return path;
}
