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
   * Brings the commit a new checkout starts from into the workspace's repository, and points
   * `context.ref` at it. Called each time a session starts afresh, never when it resumes.
   */
  fetch(context: SourceFetchContext): Promise<void>;
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
