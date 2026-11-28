import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

/**
 * Where the code of a workspace comes from: `gitRepository()`, a repository a Git server serves;
 * `sandboxRepository()`, one already in the sandbox; `hostRepository()`, one on this host. Write
 * your own for another origin.
 */
export interface WorkspaceSource {
  /**
   * Names the repository the workspace keeps in the sandbox, `<name>.git`: the sessions of every
   * workspace with this name, in one sandbox, share it.
   */
  readonly name: string;
  /**
   * The hosts the sandbox reaches to fetch the repository, as the `allowedHosts` of a network
   * policy lists them: a hostname, without scheme, port or path. `['github.com']` for
   * `gitRepository()` of a GitHub URL; none for `hostRepository()` and `sandboxRepository()`,
   * whose commits reach the sandbox without it reaching any host. Left out, a source is taken to
   * need none.
   */
  readonly hosts?: readonly string[];
  /**
   * Brings the commit a new checkout starts from into the workspace's repository, and points
   * `context.ref` at it. Called each time a session starts afresh, never when it resumes.
   */
  fetch(context: SourceFetchContext): Promise<void>;
  /**
   * Prepares a session's checkout to reach the source on its own — a remote, the credential its
   * fetches take —: called once the checkout is made, and each time the session resumes. What it
   * returns lives as long as the session: the workspace calls its `close` when the session is
   * suspended or closed. Left out, the checkout reaches nothing.
   */
  connect?(context: SourceConnectContext): Promise<SourceConnection | undefined>;
}

/** What a {@link WorkspaceSource} connects. */
export interface SourceConnectContext {
  /** The sandbox of the session, as its sandbox package gives it. */
  readonly sandbox: HarnessV1NetworkSandboxSession;
  /** The workspace's repository in the sandbox, bare: an absolute path. */
  readonly repository: string;
  /** The session's checkout of it: an absolute path. */
  readonly directory: string;
  /** The session the checkout is for. */
  readonly sessionId: string;
  readonly abortSignal?: AbortSignal;
}

/** What a {@link WorkspaceSource} keeps up for a session's checkout while the session lives. */
export interface SourceConnection {
  /** Renews what the checkout's fetches take, such as a credential that expires. */
  refresh?(options?: { abortSignal?: AbortSignal }): Promise<void>;
  /** The session is suspended or closed: stops what the connection runs, such as a timer. */
  close?(): void;
}

/** What a {@link WorkspaceSource} fetches into. */
export interface SourceFetchContext {
  /**
   * The sandbox of the session, as its sandbox package gives it: with its credential brokering
   * (`addRequestTransformations`) when it has one.
   */
  readonly sandbox: HarnessV1NetworkSandboxSession;
  /** The workspace's repository in the sandbox, bare: an absolute path. */
  readonly repository: string;
  /** The ref of {@link repository} to point at the commit, such as `refs/ai-sdk-harness/fetched/<session>`. */
  readonly ref: string;
  /** The session the checkout is for. */
  readonly sessionId: string;
  readonly abortSignal?: AbortSignal;
}
