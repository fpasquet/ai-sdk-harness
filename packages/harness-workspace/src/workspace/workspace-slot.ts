import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import { posix } from 'node:path';

import type { WorkspaceSource } from '../definitions/source.js';
import type {
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
} from '../git/repository.js';
import { baseRef, checkRelativePath, fetchedRef, sessionKey } from '../utils/names.js';

/** What a workspace gives each of its slots. */
export interface SlotSettings {
  source: WorkspaceSource;
  setup: readonly string[];
  setupEnv: Record<string, string> | undefined;
  setupTimeoutMs: number;
  branch: (sessionId: string) => string;
  committer: { name: string; email: string };
  repositoryPath: string | undefined;
}

/**
 * One session's share of the workspace: its sandbox, and once {@link prepare} ran, its checkout.
 * Everything about it derives from the session id, so that a resume finds it again.
 */
export class WorkspaceSlot {
  readonly sessionId: string;
  /** The sandbox as its sandbox package gives it: the session's harness gets a view of it. */
  readonly sandbox: HarnessV1NetworkSandboxSession;
  readonly branch: string;
  private readonly resume: boolean;
  private readonly key: string;
  private repository: Promise<string> | undefined;
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

  /** The checkout, while the slot holds it. */
  get session(): undefined | WorkspaceSession {
    return this.released ? undefined : this.checkedOut;
  }

  /**
   * Checks the repository out in `directory`, the session's working directory — or, when the
   * session resumes, makes sure its checkout is still there.
   */
  async prepare(directory: string, abortSignal?: AbortSignal): Promise<void> {
    const repository = await this.repositoryOf(abortSignal);
    const base = baseRef(this.key);
    if (this.resume) {
      const commit = await reattach(this.sandbox, { repository, directory, base, abortSignal });
      if (commit === undefined) throw new WorkspaceLostError(this.sessionId);
      this.checkedOut = this.sessionAt(directory, commit);
      return;
    }
    const fetched = fetchedRef(this.key);
    await this.settings.source.fetch({
      sandbox: this.sandbox,
      repository,
      ref: fetched,
      sessionId: this.sessionId,
      ...(abortSignal !== undefined && { abortSignal }),
    });
    const commit = await checkout(this.sandbox, {
      repository,
      directory,
      branch: this.branch,
      fetched,
      base,
      abortSignal,
    });
    this.checkedOut = this.sessionAt(directory, commit);
    for (const command of this.settings.setup) await this.setup(directory, command, abortSignal);
  }

  /** The session is suspended: its checkout stays for its resume. */
  release(): void {
    this.released = true;
  }

  /** The session is closed: its checkout, its branch and its base go. */
  async remove(): Promise<void> {
    this.released = true;
    const repository = await (this.repository ??
      locateRepository(this.sandbox, {
        path: this.settings.repositoryPath,
        name: this.settings.source.name,
      }));
    await removeCheckout(this.sandbox, {
      repository,
      branch: this.branch,
      base: baseRef(this.key),
      directory: this.checkedOut?.directory,
    });
  }

  /** The workspace's repository in this sandbox, created on first use. */
  private repositoryOf(abortSignal?: AbortSignal): Promise<string> {
    if (this.repository === undefined) {
      const { repositoryPath, source, committer } = this.settings;
      const located = (async () => {
        const repository = await locateRepository(this.sandbox, {
          path: repositoryPath,
          name: source.name,
          abortSignal,
        });
        await initRepository(this.sandbox, { repository, committer, abortSignal });
        return repository;
      })();
      this.repository = located;
      // A failure is not remembered: the next call tries again.
      located.catch(() => {
        if (this.repository === located) this.repository = undefined;
      });
    }
    return this.repository;
  }

  private async setup(
    directory: string,
    command: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const { setupEnv, setupTimeoutMs } = this.settings;
    let result: WorkspaceCommandResult;
    try {
      result = await this.sandbox.run({
        command,
        workingDirectory: directory,
        ...(setupEnv !== undefined && { env: setupEnv }),
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

  /** The checkout in `directory`, which started from `base`. */
  private sessionAt(directory: string, base: string): WorkspaceSession {
    const { sandbox, sessionId, branch } = this;
    const live = () => {
      if (this.released) {
        throw new WorkspaceError(
          `Session ${sessionId} is no longer live: its checkout cannot be reached.`,
          'session',
        );
      }
    };
    return {
      sessionId,
      directory,
      branch,
      base,
      run: async (command: string, { env, timeoutMs, abortSignal }: WorkspaceRunOptions = {}) => {
        live();
        const signal = timeoutMs === undefined ? abortSignal : withTimeout(abortSignal, timeoutMs);
        const { exitCode, stdout, stderr } = await sandbox.run({
          command,
          workingDirectory: directory,
          ...(env !== undefined && { env }),
          ...(signal !== undefined && { abortSignal: signal }),
        });
        return { exitCode, stdout, stderr };
      },
      writeLocalFile: async (path, content, { abortSignal } = {}) => {
        live();
        const relative = checkRelativePath(path);
        await keepLocal(sandbox, { directory, path: relative, abortSignal });
        const target = posix.join(directory, relative);
        const signal = abortSignal === undefined ? {} : { abortSignal };
        await (typeof content === 'string'
          ? sandbox.writeTextFile({ path: target, content, ...signal })
          : sandbox.writeBinaryFile({ path: target, content, ...signal }));
      },
      changes: async ({ abortSignal } = {}) => {
        live();
        return readChanges(sandbox, { directory, base, abortSignal });
      },
      changedFiles: async ({ abortSignal } = {}) => {
        live();
        return listChanges(sandbox, { directory, base, abortSignal });
      },
    };
  }
}

/** `signal`, aborted after `timeoutMs` as well. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
