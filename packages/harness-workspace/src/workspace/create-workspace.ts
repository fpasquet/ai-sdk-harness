import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import type {
  SessionSandboxes,
  SessionSandboxLease,
  Workspace,
  WorkspaceOptions,
  WorkspaceSession,
  WorkspaceSessionInput,
} from '../definitions/workspace.js';
import type { SlotSettings } from './workspace-slot.js';

import { WorkspaceError } from '../errors/workspace-error.js';
import { isRevision, sessionKey } from '../utils/names.js';
import { WorkspaceSlot } from './workspace-slot.js';

const DEFAULT_COMMITTER = { name: 'Harness agent', email: 'agent@ai-sdk-harness.invalid' };

/**
 * A Git workspace for the sessions of a `HarnessAgent`: the repository of `source` checked out for
 * each session, in the working directory the harness makes for it, as a worktree on a branch of
 * its own — so that sessions on one repository work side by side in one sandbox — and what the
 * agent changed, read back as a patch.
 *
 * ```ts
 * const workspace = createWorkspace({
 *   source: gitRepository({ url: 'https://github.com/acme/widgets.git' }),
 *   setup: ['pnpm install --frozen-lockfile'],
 * });
 * const agent = new HarnessAgent(withWorkspace({ harness, model }, workspace));
 * const sessions = createSessionManager({
 *   agent: () => agent,
 *   sandboxes: workspace.sandboxes(sharedSandbox({ open, ports })),
 * });
 * // Later: what the agent of session `id` changed.
 * const patch = await workspace.session(id)?.changes();
 * ```
 *
 * The repository itself is kept bare in the sandbox, outside the sessions' working directories,
 * and shared by the sessions of the sandbox: a new session fetches only what it lacks.
 */
export function createWorkspace(options: WorkspaceOptions): Workspace {
  const settings: SlotSettings = {
    source: options.source,
    setup: typeof options.setup === 'string' ? [options.setup] : [...(options.setup ?? [])],
    setupEnv: options.setupEnv,
    setupTimeoutMs: options.setupTimeoutMs ?? 600_000,
    branch: checkedBranch(options.branch ?? ((sessionId) => `session/${sessionKey(sessionId)}`)),
    committer: options.committer ?? DEFAULT_COMMITTER,
    repositoryPath: options.repositoryPath,
  };
  if (settings.repositoryPath !== undefined && !settings.repositoryPath.startsWith('/')) {
    throw new TypeError(
      `\`repositoryPath\` must be an absolute path; got ${JSON.stringify(settings.repositoryPath)}.`,
    );
  }
  return new GitWorkspace(settings);
}

class GitWorkspace implements Workspace {
  /** The sandbox views a slot handed out, and those their `restricted()` made: what `onSession` gets. */
  private readonly bySandbox = new WeakMap<object, WorkspaceSlot>();
  /** Session id → its latest slot. */
  private readonly live = new Map<string, WorkspaceSlot>();

  constructor(private readonly settings: SlotSettings) {}

  sandboxes = (inner: SessionSandboxes): SessionSandboxes => {
    const shutdown =
      inner.shutdown === undefined
        ? undefined
        : async () => {
            await inner.shutdown?.();
          };
    return {
      ...(inner.capacity !== undefined && { capacity: inner.capacity }),
      acquire: async (sessionId, options) => {
        const lease = await inner.acquire(sessionId, options);
        const { slot, sandboxSession } = this.attach(
          sessionId,
          lease.sandboxSession,
          options.resume,
        );
        return {
          sandboxSession,
          suspend: async () => {
            this.release(slot);
            await lease.suspend();
          },
          close: async () => {
            try {
              await slot.remove();
            } finally {
              this.release(slot);
              await lease.close();
            }
          },
        };
      },
      // A session closed while it was suspended: its checkout goes, as when a live one is closed.
      discard: async (sessionId) => {
        let lease: SessionSandboxLease;
        try {
          lease = await inner.acquire(sessionId, { resume: true });
        } catch (error) {
          if (inner.discard === undefined) throw error;
          return inner.discard(sessionId);
        }
        const { slot } = this.attach(sessionId, lease.sandboxSession, true);
        try {
          await slot.remove();
        } finally {
          this.release(slot);
          await lease.close();
        }
      },
      ...(shutdown !== undefined && { shutdown }),
    };
  };

  open = ({
    sessionId,
    sandboxSession,
    resume = false,
  }: {
    sessionId: string;
    sandboxSession: HarnessV1NetworkSandboxSession;
    resume?: boolean;
  }): SessionSandboxLease => {
    const attached = this.attach(sessionId, sandboxSession, resume);
    const { slot } = attached;
    return {
      sandboxSession: attached.sandboxSession,
      suspend: () => {
        this.release(slot);
        return Promise.resolve();
      },
      close: async () => {
        try {
          await slot.remove();
        } finally {
          this.release(slot);
        }
      },
    };
  };

  onSession = async ({
    session,
    sessionWorkDir,
    abortSignal,
  }: WorkspaceSessionInput): Promise<void> => {
    const slot = this.bySandbox.get(session);
    if (slot === undefined) {
      throw new WorkspaceError(
        "The session's sandbox does not come from this workspace: hand the agent's sessions the sandboxes of workspace.sandboxes(), or of workspace.open().",
        'checkout',
      );
    }
    await slot.prepare(sessionWorkDir, abortSignal);
  };

  session = (sessionId: string): undefined | WorkspaceSession => this.live.get(sessionId)?.session;

  fromSandbox = (sandbox: SandboxSession): undefined | WorkspaceSession =>
    this.bySandbox.get(sandbox)?.session;

  /**
   * A slot for session `sessionId` in `sandbox`, and the view of the sandbox its harness gets: the
   * same sandbox, whose `restricted()` views are known to the workspace, so that `onSession` and
   * the tools find the slot from the view they are given.
   */
  private attach(
    sessionId: string,
    sandbox: HarnessV1NetworkSandboxSession,
    resume: boolean,
  ): { slot: WorkspaceSlot; sandboxSession: HarnessV1NetworkSandboxSession } {
    const slot = new WorkspaceSlot({ sessionId, sandbox, resume }, this.settings);
    this.live.get(sessionId)?.release();
    this.live.set(sessionId, slot);
    const sandboxSession = new Proxy(sandbox, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property === 'restricted') {
          return () => {
            const restricted = (value as () => SandboxSession).call(target);
            this.bySandbox.set(restricted, slot);
            return restricted;
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    this.bySandbox.set(sandboxSession, slot);
    return { slot, sandboxSession };
  }

  private release(slot: WorkspaceSlot): void {
    slot.release();
    if (this.live.get(slot.sessionId) === slot) this.live.delete(slot.sessionId);
  }
}

/** `branch`, its names checked before git sees them. */
function checkedBranch(branch: (sessionId: string) => string): (sessionId: string) => string {
  return (sessionId) => {
    const name = branch(sessionId);
    if (!isRevision(name) || name === 'HEAD') {
      throw new TypeError(
        `The branch of session ${sessionId} is not a valid branch name: ${JSON.stringify(name)}.`,
      );
    }
    return name;
  };
}
