import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import type { WorkspaceSource } from './source.js';

export interface WorkspaceOptions {
  /** Where the code comes from: `gitRepository()`, `sandboxRepository()` or `hostRepository()`. */
  source: WorkspaceSource;
  /**
   * Commands run in a new checkout before the agent starts, one after the other, such as
   * `pnpm install --frozen-lockfile`. Not run again when the session resumes. A command that fails
   * fails the start of the session with `WorkspaceSetupError`.
   */
  setup?: readonly string[] | string;
  /** Variables of the setup commands' environment. Never put a secret here: the agent can read them back. */
  setupEnv?: Record<string, string>;
  /**
   * How long each setup command may run, in milliseconds.
   *
   * @defaultValue `600_000` (10 minutes)
   */
  setupTimeoutMs?: number;
  /**
   * The branch a session's checkout is on.
   *
   * @defaultValue `session/<sessionId>`, the id hashed when it does not fit in a branch name
   */
  branch?: (sessionId: string) => string;
  /**
   * Who the agents' commits are by, unless git in the sandbox already knows who: an agent's commit
   * fails without it.
   *
   * @defaultValue `{ name: 'Harness agent', email: 'agent@ai-sdk-harness.invalid' }`
   */
  committer?: { name: string; email: string };
  /**
   * Where the workspace keeps its repository in the sandbox, bare: an absolute path. Outside the
   * sessions' working directories, so that an agent climbing out of its own does not find it.
   *
   * @defaultValue `$HOME/.ai-sdk-harness/repositories/<source name>.git`
   */
  repositoryPath?: string;
}

/** What a command run in a checkout gave. */
export interface WorkspaceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceRunOptions {
  /** Variables of the command's environment, on top of the sandbox's. */
  env?: Record<string, string>;
  /** Kills the command after this long, in milliseconds. Default: never. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/** A file a session changed since its checkout started. */
export interface ChangedFile {
  /** Its path, relative to the checkout. */
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'type-changed';
  /** Lines added; `0` for a binary file. */
  additions: number;
  /** Lines removed; `0` for a binary file. */
  deletions: number;
  binary: boolean;
}

/**
 * The checkout of a live session: a Git worktree of the workspace's repository, in the session's
 * working directory, on a branch of its own.
 */
export interface WorkspaceSession {
  readonly sessionId: string;
  /** The checkout: the session's working directory, where its agent works. */
  readonly directory: string;
  /** The branch it was checked out on. The agent may switch to another; its changes still count. */
  readonly branch: string;
  /** The commit the checkout started from: what {@link changes} compares the checkout with. */
  readonly base: string;
  /** Runs `command` in the sandbox, in the checkout: a test suite, a build, a host tool's command. */
  run(command: string, options?: WorkspaceRunOptions): Promise<WorkspaceCommandResult>;
  /**
   * Writes a file of the session's own at `path`, relative to the checkout, kept out of
   * {@link changes} and {@link changedFiles} whether the repository has a file there or not: an
   * `.env.local`, settings of the runtime.
   */
  writeLocalFile(
    path: string,
    content: string | Uint8Array,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  /**
   * Everything that changed in the checkout since {@link base}, as a patch `git apply` takes,
   * byte for byte: edits, new files, deletions, binary files, and the commits the agent made.
   * Files the repository ignores, and local files, are left out. Empty when nothing changed.
   */
  changes(options?: { abortSignal?: AbortSignal }): Promise<Uint8Array>;
  /** The files {@link changes} holds, with how many lines each gained and lost. */
  changedFiles(options?: { abortSignal?: AbortSignal }): Promise<ChangedFile[]>;
}

/** The sandbox a session holds while it is live, the same shape as in `ai-sdk-harness-sessions`. */
export interface SessionSandboxLease {
  /** What the session's harness runs in: handed to `HarnessAgent.createSession()`. */
  readonly sandboxSession: HarnessV1NetworkSandboxSession;
  /** The session is suspended: free what it holds, keep what a resume needs. */
  suspend(): Promise<void>;
  /** The session is closed for good: free what it holds, its files included when they are its own. */
  close(): Promise<void>;
}

/**
 * How sessions get a sandbox, the `SessionSandboxes` of `ai-sdk-harness-sessions`:
 * `sharedSandbox()`, `sandboxPerSession()` or your own.
 */
export interface SessionSandboxes {
  readonly capacity?: number;
  acquire(
    sessionId: string,
    options: { resume: boolean; abortSignal?: AbortSignal },
  ): Promise<SessionSandboxLease>;
  discard?(sessionId: string): Promise<void>;
  shutdown?(): Promise<void>;
}

/** What `sandboxConfig.onSession` of a `HarnessAgent` is called with. */
export interface WorkspaceSessionInput {
  readonly session: SandboxSession;
  readonly sessionWorkDir: string;
  readonly abortSignal?: AbortSignal;
}

/**
 * A repository checked out for each session of a `HarnessAgent`. See {@link createWorkspace}.
 *
 * Two steps tie it to the sessions: {@link sandboxes} (or {@link open}) knows the sandbox of each
 * session, and {@link onSession} (`withWorkspace()` sets it on the agent) checks the repository out
 * in the working directory the harness made for it.
 */
export interface Workspace {
  /**
   * `sandboxes` with a checkout for each session: made when it starts, kept when it is suspended,
   * found again when it resumes, removed when it is closed. Hand it to `createSessionManager()`.
   */
  sandboxes(sandboxes: SessionSandboxes): SessionSandboxes;
  /**
   * Without a session manager: ties `sandboxSession` to session `sessionId`. Hand the lease's
   * `sandboxSession` to `HarnessAgent.createSession()`; `close()` removes the checkout,
   * `suspend()` keeps it. Neither stops the sandbox: it is yours. `resume`: the session resumes,
   * its checkout must be there.
   */
  open(options: {
    sessionId: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
    resume?: boolean;
  }): SessionSandboxLease;
  /**
   * The `sandboxConfig.onSession` of the agent: checks the repository out in `sessionWorkDir`, or
   * makes sure the checkout is still there when the session resumes. `withWorkspace()` sets it.
   */
  onSession(input: WorkspaceSessionInput): Promise<void>;
  /** The checkout of session `sessionId`, while it is live and checked out. */
  session(sessionId: string): undefined | WorkspaceSession;
  /**
   * The checkout of the session a sandbox belongs to: the `experimental_sandbox` a tool's
   * `execute` receives, for a host tool to work in the session's checkout.
   */
  fromSandbox(sandbox: SandboxSession): undefined | WorkspaceSession;
}
