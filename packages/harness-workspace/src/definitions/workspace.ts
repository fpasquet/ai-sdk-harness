import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import type { WorkspaceSource } from './source.js';

/** What every workspace takes, with one repository or several. */
interface WorkspaceCommonOptions {
  /**
   * Commands run before the agent starts, one after the other, such as
   * `pnpm install --frozen-lockfile`: in the checkout with `source`; with `repositories`, in the
   * session's working directory, after those of each repository. Not run again when the session
   * resumes. A command that fails fails the start of the session with `WorkspaceSetupError`.
   */
  setup?: readonly string[] | string;
  /**
   * Variables of the setup commands' environment, those of every repository's included. Never put
   * a secret here: the agent can read them back.
   */
  setupEnv?: Record<string, string>;
  /**
   * How long each setup command may run, in milliseconds.
   *
   * @defaultValue `600_000` (10 minutes)
   */
  setupTimeoutMs?: number;
  /**
   * The branch a session's checkouts are on, the same in each repository.
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
}

/** One repository, checked out in the session's working directory itself. */
export interface SingleRepositoryWorkspaceOptions extends WorkspaceCommonOptions {
  /** Where the code comes from: `gitRepository()`, `sandboxRepository()` or `hostRepository()`. */
  source: WorkspaceSource;
  /**
   * Where the workspace keeps its repository in the sandbox, bare: an absolute path. Outside the
   * sessions' working directories, so that an agent climbing out of its own does not find it.
   *
   * @defaultValue `$HOME/.ai-sdk-harness/repositories/<source name>.git`
   */
  repositoryPath?: string;
  repositories?: never;
}

/**
 * Several repositories — an API, a web app, services —, each checked out in a directory of the
 * session's working directory named after its key: `{ api: …, 'services/billing': … }`.
 */
export interface MultiRepositoryWorkspaceOptions extends WorkspaceCommonOptions {
  /**
   * Each repository by the directory it is checked out in: its source, or its settings. A function
   * gives them per session, when sessions work on different repositories — a project each, say —
   * so that one workspace, and one session manager, serves them all: it is called once each time a
   * session starts, resumes or is closed, before anything runs in its sandbox.
   */
  repositories: WorkspaceRepositories | WorkspaceRepositoriesOf;
  source?: never;
  repositoryPath?: never;
}

/** Repositories of a workspace, by the directory each is checked out in. */
export type WorkspaceRepositories = Record<string, WorkspaceRepositoryOptions | WorkspaceSource>;

/**
 * The repositories of session `sessionId`: from what your application keeps with it, a project
 * looked up in your database for instance.
 */
export type WorkspaceRepositoriesOf = (session: {
  sessionId: string;
  abortSignal?: AbortSignal;
}) => PromiseLike<WorkspaceRepositories> | WorkspaceRepositories;

/** One of the {@link MultiRepositoryWorkspaceOptions.repositories}. */
export interface WorkspaceRepositoryOptions {
  /** Where the code comes from: `gitRepository()`, `sandboxRepository()` or `hostRepository()`. */
  source: WorkspaceSource;
  /** Commands run in this repository's new checkout, before the workspace's own `setup`. */
  setup?: readonly string[] | string;
  /** Variables of this repository's setup commands, on top of the workspace's `setupEnv`. */
  setupEnv?: Record<string, string>;
  /**
   * Where the workspace keeps this repository in the sandbox, bare: an absolute path.
   *
   * @defaultValue `$HOME/.ai-sdk-harness/repositories/<source name>.git`
   */
  repositoryPath?: string;
}

/**
 * `{ source }` for one repository, checked out in each session's working directory;
 * `{ repositories }` for several, each in a directory of it.
 */
export type WorkspaceOptions = MultiRepositoryWorkspaceOptions | SingleRepositoryWorkspaceOptions;

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
  /**
   * Its path, relative to the directory whose changes were asked for: the session's working
   * directory, or the checkout of one repository.
   */
  path: string;
  /** The name of the repository it is in: the key of `repositories`, or the source's name. */
  repository: string;
  status: 'added' | 'deleted' | 'modified' | 'type-changed';
  /** Lines added; `0` for a binary file. */
  additions: number;
  /** Lines removed; `0` for a binary file. */
  deletions: number;
  binary: boolean;
  /**
   * Its Git mode once changed: `100644` a file, `100755` an executable, `120000` a symbolic link,
   * `160000` a submodule. Absent for a deleted file.
   */
  mode?: GitFileMode;
  /**
   * What the repository would hold, byte for byte, once the change is committed: the content of a
   * file, the target of a symbolic link. With `{ contents: true }` only; absent for a deleted file
   * and a submodule.
   */
  content?: Uint8Array;
}

/** A file's mode, as Git records it. */
export type GitFileMode = '100644' | '100755' | '120000' | '160000';

/** What {@link CheckoutOperations.changedFiles} reads. */
export interface ChangedFilesOptions {
  /**
   * Reads each file's `content` too, as Git stores it: enough to publish the change through a
   * forge's API — blobs, a tree, a commit — without pushing from the sandbox.
   */
  contents?: boolean;
  abortSignal?: AbortSignal;
}

/** What a session's checkout, or all of them at once, can be asked. */
interface CheckoutOperations {
  /** Runs `command` in the sandbox, in {@link directory}: a test suite, a build, a host tool's command. */
  run(command: string, options?: WorkspaceRunOptions): Promise<WorkspaceCommandResult>;
  /**
   * Writes a file of the session's own at `path`, relative to {@link directory}, kept out of
   * {@link changes} and {@link changedFiles} whether the repository has a file there or not: an
   * `.env.local`, settings of the runtime.
   */
  writeLocalFile(
    path: string,
    content: string | Uint8Array,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  /**
   * Everything that changed since the checkout started, as a patch `git apply` takes in
   * {@link directory}, byte for byte: edits, new files, deletions, binary files, and the commits
   * the agent made. Files the repository ignores, and local files, are left out. Empty when
   * nothing changed.
   */
  changes(options?: { abortSignal?: AbortSignal }): Promise<Uint8Array>;
  /**
   * The files {@link changes} holds, with how many lines each gained and lost and its mode; their
   * content too with `contents: true`.
   */
  changedFiles(options?: ChangedFilesOptions): Promise<ChangedFile[]>;
  /** Where it all happens. */
  readonly directory: string;
}

/**
 * The checkout of one repository for a live session: a Git worktree of the workspace's repository,
 * on a branch of its own.
 */
export interface WorkspaceCheckout extends CheckoutOperations {
  /** The repository's name: the key of `repositories`, or the source's name. */
  readonly name: string;
  /** The checkout: the session's working directory, or a directory of it. */
  readonly directory: string;
  /** The branch it was checked out on. The agent may switch to another; its changes still count. */
  readonly branch: string;
  /** The commit the checkout started from: what {@link changes} compares the checkout with. */
  readonly base: string;
}

/**
 * The checkouts of a live session, in its working directory. With one repository, the working
 * directory is its checkout: {@link changes} and the others are those of the checkout. With
 * several, they take them all, their paths relative to the working directory.
 */
export interface WorkspaceSession extends CheckoutOperations {
  readonly sessionId: string;
  /** The session's working directory, where its agent works. */
  readonly directory: string;
  /** The branch its checkouts were made on. */
  readonly branch: string;
  /** Its checkouts, in the order of the workspace's repositories. */
  readonly repositories: readonly WorkspaceCheckout[];
  /** The checkout of repository `name`. */
  repository(name: string): undefined | WorkspaceCheckout;
}

/** The session of a workspace of one repository, whose working directory is its checkout. */
export interface SingleRepositoryWorkspaceSession extends WorkspaceSession {
  /** The commit the checkout started from: what {@link changes} compares the checkout with. */
  readonly base: string;
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
 * Repositories checked out for each session of a `HarnessAgent`. See {@link createWorkspace}.
 *
 * Two steps tie it to the sessions: {@link sandboxes} (or {@link open}) knows the sandbox of each
 * session, and {@link onSession} (`withWorkspace()` sets it on the agent) checks the repository out
 * in the working directory the harness made for it.
 */
export interface Workspace<SESSION extends WorkspaceSession = WorkspaceSession> {
  /**
   * `sandboxes` with checkouts for each session: made when it starts, kept when it is suspended,
   * found again when it resumes, removed when it is closed. Hand it to `createSessionManager()`.
   */
  sandboxes(sandboxes: SessionSandboxes): SessionSandboxes;
  /**
   * Without a session manager: ties `sandboxSession` to session `sessionId`. Hand the lease's
   * `sandboxSession` to `HarnessAgent.createSession()`; `close()` removes the checkouts,
   * `suspend()` keeps them. Neither stops the sandbox: it is yours. `resume`: the session resumes,
   * its checkouts must be there.
   */
  open(options: {
    sessionId: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
    resume?: boolean;
  }): SessionSandboxLease;
  /**
   * The `sandboxConfig.onSession` of the agent: checks the repositories out in `sessionWorkDir`, or
   * makes sure the checkouts are still there when the session resumes. `withWorkspace()` sets it.
   */
  onSession(input: WorkspaceSessionInput): Promise<void>;
  /**
   * The hosts the sandbox reaches to fetch the workspace's repositories, each once, in the order
   * of the repositories: add them to the `allowedHosts` of a sandbox whose network policy is
   * closed, or its checkouts fail. Hostnames only, as a network policy takes them: it allows a
   * host on every port.
   *
   * When `repositories` is a function, they are those of session `sessionId`, asked of it as a
   * start does: pass the session, or the promise rejects with a `TypeError`. Otherwise `session` is
   * not needed.
   */
  hosts(session?: { sessionId: string; abortSignal?: AbortSignal }): Promise<string[]>;
  /** The checkouts of session `sessionId`, while it is live and checked out. */
  session(sessionId: string): SESSION | undefined;
  /**
   * The checkouts of the session a sandbox belongs to: the `experimental_sandbox` a tool's
   * `execute` receives, for a host tool to work in the session's checkouts.
   */
  fromSandbox(sandbox: SandboxSession): SESSION | undefined;
}
