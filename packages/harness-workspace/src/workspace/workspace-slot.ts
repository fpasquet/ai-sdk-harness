import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import { posix } from 'node:path';

import type { WorkspaceSource } from '../definitions/source.js';
import type {
  WorkspaceCheckout,
  WorkspaceCommandResult,
  WorkspaceRunOptions,
  WorkspaceSession,
} from '../definitions/workspace.js';

import { WorkspaceError } from '../errors/workspace-error.js';
import { WorkspaceLostError } from '../errors/workspace-lost-error.js';
import { WorkspaceSetupError } from '../errors/workspace-setup-error.js';
import {
  checkout,
  initRepository,
  keepLocal,
  listChanges,
  locateRepository,
  readChanges,
  reattach,
  removeCheckout,
  removeDirectory,
} from '../git/repository.js';
import { baseRef, checkRelativePath, fetchedRef, sessionKey } from '../utils/names.js';

/** One repository of a workspace. */
export interface RepositorySettings {
  name: string;
  /** Its checkout's directory in the session's working directory; `''` for that directory itself. */
  path: string;
  source: WorkspaceSource;
  setup: readonly string[];
  setupEnv: Record<string, string> | undefined;
  repositoryPath: string | undefined;
}

/** What a workspace gives each of its slots. */
export interface SlotSettings {
  repositories: readonly RepositorySettings[];
  /** Run in the session's working directory, after the setup of every repository. */
  setup: readonly string[];
  setupEnv: Record<string, string> | undefined;
  setupTimeoutMs: number;
  branch: (sessionId: string) => string;
  committer: { name: string; email: string };
}

/** A repository checked out for the session. */
interface CheckedOut {
  repository: RepositorySettings;
  directory: string;
  base: string;
}

/**
 * One session's share of the workspace: its sandbox, and once {@link prepare} ran, its checkouts.
 * Everything about it derives from the session id, so that a resume finds it again.
 */
export class WorkspaceSlot {
  readonly sessionId: string;
  /** The sandbox as its sandbox package gives it: the session's harness gets a view of it. */
  readonly sandbox: HarnessV1NetworkSandboxSession;
  readonly branch: string;
  private readonly resume: boolean;
  private readonly key: string;
  /** Repository name → the workspace's repository of it in this sandbox. */
  private readonly located = new Map<string, Promise<string>>();
  private checkedOut: undefined | WorkspaceSession;
  private released = false;

  constructor(
    {
      sessionId,
      sandbox,
      resume,
    }: { sessionId: string; sandbox: HarnessV1NetworkSandboxSession; resume: boolean },
    private readonly settings: SlotSettings,
  ) {
    this.sessionId = sessionId;
    this.sandbox = sandbox;
    this.resume = resume;
    this.key = sessionKey(sessionId);
    this.branch = settings.branch(sessionId);
  }

  /** The checkouts, while the slot holds them. */
  get session(): undefined | WorkspaceSession {
    return this.released ? undefined : this.checkedOut;
  }

  /**
   * Checks the repositories out in `directory`, the session's working directory — or, when the
   * session resumes, makes sure their checkouts are still there.
   */
  async prepare(directory: string, abortSignal?: AbortSignal): Promise<void> {
    const checkouts = await settled(
      this.settings.repositories.map((repository) =>
        this.prepareRepository(repository, directory, abortSignal),
      ),
    );
    this.checkedOut = this.sessionAt(directory, checkouts);
    if (this.resume) return;
    const { setup, setupEnv } = this.settings;
    for (const { repository, directory: at } of checkouts) {
      const env = merged(setupEnv, repository.setupEnv);
      for (const command of repository.setup) {
        await this.setup(command, { directory: at, env, abortSignal });
      }
    }
    for (const command of setup) {
      await this.setup(command, { directory, env: setupEnv, abortSignal });
    }
  }

  /** The session is suspended: its checkouts stay for its resume. */
  release(): void {
    this.released = true;
  }

  /** The session is closed: its checkouts, their branch and their bases go. */
  async remove(): Promise<void> {
    this.released = true;
    const removed = await settled(
      this.settings.repositories.map(async (repository) => {
        const located =
          this.located.get(repository.name) ??
          locateRepository(this.sandbox, {
            path: repository.repositoryPath,
            name: repository.source.name,
          });
        const directory = await removeCheckout(this.sandbox, {
          repository: await located,
          branch: this.branch,
          base: baseRef(this.key),
          directory: this.checkedOut?.repository(repository.name)?.directory,
        });
        return { repository, directory };
      }),
    );
    // With several repositories, the working directory holding their checkouts goes as well.
    if (this.settings.repositories.every(({ path }) => path === '')) return;
    const root = this.checkedOut?.directory ?? rootOf(removed);
    if (root !== undefined) await removeDirectory(this.sandbox, { path: root });
  }

  private async prepareRepository(
    repository: RepositorySettings,
    root: string,
    abortSignal?: AbortSignal,
  ): Promise<CheckedOut> {
    const located = await this.repositoryOf(repository, abortSignal);
    const directory = repository.path === '' ? root : posix.join(root, repository.path);
    const base = baseRef(this.key);
    if (this.resume) {
      const commit = await reattach(this.sandbox, {
        repository: located,
        directory,
        base,
        abortSignal,
      });
      if (commit === undefined) {
        throw new WorkspaceLostError(
          this.sessionId,
          repository.path === '' ? undefined : repository.name,
        );
      }
      return { repository, directory, base: commit };
    }
    const fetched = fetchedRef(this.key);
    await repository.source.fetch({
      sandbox: this.sandbox,
      repository: located,
      ref: fetched,
      sessionId: this.sessionId,
      ...(abortSignal !== undefined && { abortSignal }),
    });
    const commit = await checkout(this.sandbox, {
      repository: located,
      directory,
      branch: this.branch,
      fetched,
      base,
      abortSignal,
    });
    return { repository, directory, base: commit };
  }

  /** The workspace's repository of `repository` in this sandbox, created on first use. */
  private repositoryOf(repository: RepositorySettings, abortSignal?: AbortSignal): Promise<string> {
    const known = this.located.get(repository.name);
    if (known !== undefined) return known;
    const { committer } = this.settings;
    const located = (async () => {
      const path = await locateRepository(this.sandbox, {
        path: repository.repositoryPath,
        name: repository.source.name,
        abortSignal,
      });
      await initRepository(this.sandbox, { repository: path, committer, abortSignal });
      return path;
    })();
    this.located.set(repository.name, located);
    // A failure is not remembered: the next call tries again.
    located.catch(() => {
      if (this.located.get(repository.name) === located) this.located.delete(repository.name);
    });
    return located;
  }

  private async setup(
    command: string,
    {
      directory,
      env,
      abortSignal,
    }: { directory: string; env: Record<string, string> | undefined; abortSignal?: AbortSignal },
  ): Promise<void> {
    const { setupTimeoutMs } = this.settings;
    let result: WorkspaceCommandResult;
    try {
      result = await this.sandbox.run({
        command,
        workingDirectory: directory,
        ...(env !== undefined && { env }),
        abortSignal: withTimeout(abortSignal, setupTimeoutMs),
      });
    } catch (error) {
      if (abortSignal?.aborted === true) throw error;
      throw new WorkspaceSetupError(
        command,
        -1,
        `Stopped after ${setupTimeoutMs} ms: ${messageOf(error)}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new WorkspaceSetupError(command, result.exitCode, `${result.stdout}\n${result.stderr}`);
    }
  }

  /** The session in `directory`, its repositories checked out as `checkouts` say. */
  private sessionAt(directory: string, checkouts: readonly CheckedOut[]): WorkspaceSession {
    const { sessionId, branch, sandbox } = this;
    const parts = checkouts.map((checkedOut) => ({
      ...checkedOut,
      checkout: this.checkoutAt(checkedOut),
    }));
    const repositories = parts.map(({ checkout }) => checkout);
    const [first] = checkouts;
    return {
      sessionId,
      directory,
      branch,
      // One repository in the working directory itself: the session is its checkout, base included.
      ...(checkouts.length === 1 && first?.repository.path === '' && { base: first.base }),
      repositories,
      repository: (name) => repositories.find((repository) => repository.name === name),
      run: (command, options) => this.runIn(directory, command, options),
      writeLocalFile: async (path, content, { abortSignal } = {}) => {
        this.live();
        const relative = checkRelativePath(path);
        const owner = parts.find(
          ({ repository: { path: prefix } }) => prefix === '' || relative.startsWith(`${prefix}/`),
        );
        if (owner === undefined) {
          // Outside every checkout: in no repository's changes anyway.
          return this.write(posix.join(directory, relative), content, abortSignal);
        }
        const { path: prefix } = owner.repository;
        const inside = prefix === '' ? relative : relative.slice(prefix.length + 1);
        await owner.checkout.writeLocalFile(inside, content, {
          ...(abortSignal !== undefined && { abortSignal }),
        });
      },
      changes: async ({ abortSignal } = {}) => {
        this.live();
        const patches = await Promise.all(
          checkouts.map(({ repository, directory: at, base }) =>
            readChanges(sandbox, { directory: at, base, prefix: repository.path, abortSignal }),
          ),
        );
        return concat(patches);
      },
      changedFiles: async ({ abortSignal } = {}) => {
        this.live();
        const lists = await Promise.all(
          checkouts.map(({ repository: { name, path: prefix }, directory: at, base }) =>
            listChanges(sandbox, { directory: at, base, repository: name, prefix, abortSignal }),
          ),
        );
        return lists.flat();
      },
    };
  }

  /** The checkout of one repository, in `directory`, which started from `base`. */
  private checkoutAt({ repository, directory, base }: CheckedOut): WorkspaceCheckout {
    const { sandbox, branch } = this;
    return {
      name: repository.name,
      directory,
      branch,
      base,
      run: (command, options) => this.runIn(directory, command, options),
      writeLocalFile: async (path, content, { abortSignal } = {}) => {
        this.live();
        const relative = checkRelativePath(path);
        await keepLocal(sandbox, { directory, path: relative, abortSignal });
        await this.write(posix.join(directory, relative), content, abortSignal);
      },
      changes: async ({ abortSignal } = {}) => {
        this.live();
        return readChanges(sandbox, { directory, base, abortSignal });
      },
      changedFiles: async ({ abortSignal } = {}) => {
        this.live();
        return listChanges(sandbox, { directory, base, repository: repository.name, abortSignal });
      },
    };
  }

  /** Throws unless the slot still holds its checkouts. */
  private live(): void {
    if (this.released) {
      throw new WorkspaceError(
        `Session ${this.sessionId} is no longer live: its checkout cannot be reached.`,
        'session',
      );
    }
  }

  private async runIn(
    directory: string,
    command: string,
    { env, timeoutMs, abortSignal }: WorkspaceRunOptions = {},
  ): Promise<WorkspaceCommandResult> {
    this.live();
    const signal = timeoutMs === undefined ? abortSignal : withTimeout(abortSignal, timeoutMs);
    const { exitCode, stdout, stderr } = await this.sandbox.run({
      command,
      workingDirectory: directory,
      ...(env !== undefined && { env }),
      ...(signal !== undefined && { abortSignal: signal }),
    });
    return { exitCode, stdout, stderr };
  }

  private async write(
    path: string,
    content: string | Uint8Array,
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
    const signal = abortSignal === undefined ? {} : { abortSignal };
    await (typeof content === 'string'
      ? this.sandbox.writeTextFile({ path, content, ...signal })
      : this.sandbox.writeBinaryFile({ path, content, ...signal }));
  }
}

/**
 * The values of `promises`, once every one of them settled: none is left running when one fails,
 * whose error is thrown.
 */
async function settled<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/**
 * The session's working directory, from the checkouts removed in it: a checkout at `<root>/<path>`
 * says where it was, when the session closes without having been prepared.
 */
function rootOf(
  removed: readonly { repository: RepositorySettings; directory: string | undefined }[],
): string | undefined {
  for (const { repository, directory } of removed) {
    const suffix = `/${repository.path}`;
    if (directory?.endsWith(suffix) === true) {
      const root = directory.slice(0, -suffix.length);
      if (root !== '' && root !== '/') return root;
    }
  }
  return undefined;
}

function merged(
  base: Record<string, string> | undefined,
  over: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return base === undefined ? over : over === undefined ? base : { ...base, ...over };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const [only] = parts;
  if (parts.length === 1 && only !== undefined) return only;
  const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/** `signal`, aborted after `timeoutMs` as well. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
