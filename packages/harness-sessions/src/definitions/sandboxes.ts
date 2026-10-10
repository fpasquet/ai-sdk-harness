import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

/** The sandbox a session holds while it is live. */
export interface SessionSandboxLease {
  /** What the session's harness runs in: handed to `HarnessAgent.createSession()`. */
  readonly sandboxSession: HarnessV1NetworkSandboxSession;
  /** The session is suspended: free what it holds, keep what a resume needs. */
  suspend(): Promise<void>;
  /** The session is closed for good: free what it holds, its files included when they are its own. */
  close(): Promise<void>;
}

/**
 * How sessions get a sandbox: `sharedSandbox()` gives each one a view of one sandbox, with a port
 * of its own, and `sandboxPerSession()` a sandbox each. Implement it for another arrangement.
 */
export interface SessionSandboxes {
  /**
   * How many sessions may be live at once, each holding a lease; unlimited when absent. A new
   * session, or a resume, beyond it is refused with `SessionCapacityError`.
   */
  readonly capacity?: number;
  /**
   * A sandbox for session `sessionId`: a new one, or with `resume`, the one it held before it was
   * suspended. Its files must still be there for its harness to pick the conversation up.
   */
  acquire(
    sessionId: string,
    options: { resume: boolean; abortSignal?: AbortSignal },
  ): Promise<SessionSandboxLease>;
  /** A suspended session is closed: free what it still keeps, its own sandbox for instance. */
  discard?(sessionId: string): Promise<void>;
  /** The manager shuts down, its sessions suspended: stop what is still open. */
  shutdown?(): Promise<void>;
}
