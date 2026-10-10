import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import type { SessionSandboxes, SessionSandboxLease } from '../definitions/sandboxes.js';

import { SessionCapacityError } from '../errors/session-capacity-error.js';

/** A view of a sandbox, made by `fork()`, that hands back what it holds with `release()`. */
export type SandboxView = HarnessV1NetworkSandboxSession & { release(): PromiseLike<void> };

/**
 * A sandbox that gives views of itself with ports of their own: `ai-sdk-sandbox-sbx` and
 * `ai-sdk-sandbox-cloud-run` sessions are.
 */
export type ForkableSandbox = HarnessV1NetworkSandboxSession & {
  fork(options: { ports: readonly number[] }): SandboxView;
};

export interface SharedSandboxOptions {
  /**
   * Opens the sandbox, creating it or reattaching to it: called for the first session, and again
   * for the first one after the sandbox was stopped. A failure is not remembered: the next session
   * calls it again.
   *
   * A sandbox reattached after the application stopped may still run the bridges of its previous
   * sessions, holding their ports: stop them there (`killAllProcesses()`).
   */
  open(): Promise<ForkableSandbox>;
  /**
   * The ports of the sandbox the bridges of the sessions listen on, one per live session, such as
   * `Array.from({ length: 4 }, (_, i) => 4001 + i)`: free ports inside the sandbox, whose number is
   * what matters. A bridge-backed harness listens on one port per session, so as many sessions are
   * live at once — preparing, idle, busy or awaiting input — as there are ports; suspended ones hold
   * none. Every live session runs its runtime in the sandbox: size it for as many.
   */
  ports: readonly number[];
  /**
   * Stop the sandbox once no session holds it, every one suspended or closed, and when the
   * manager shuts down. On Cloud Run, a sandbox is billed while it runs; stopped, it costs its
   * snapshot's storage alone. Default: `false`, the sandbox keeps running.
   */
  stopWhenUnused?: boolean;
}

/**
 * One sandbox for every session: each live session works in a view of it (`fork()`), with a port
 * of its own for its bridge, and in a working directory of its own, which its harness names after
 * the session. A suspended session hands its port back; its files stay in the sandbox for its
 * resume.
 *
 * The sessions share the sandbox's files, network and credentials: give them one sandbox when
 * they trust each other, a sandbox each (`sandboxPerSession()`) otherwise.
 */
export function sharedSandbox(options: SharedSandboxOptions): SessionSandboxes {
  const { ports } = options;
  if (ports.length === 0 || new Set(ports).size !== ports.length) {
    throw new TypeError('sharedSandbox() needs at least one port, each listed once.');
  }
  return new SharedSandbox(options);
}

class SharedSandbox implements SessionSandboxes {
  readonly capacity: number;
  /** Session id → the port its view holds. */
  private readonly taken = new Map<string, number>();
  private opened: Promise<ForkableSandbox> | undefined;
  private stopping: Promise<void> = Promise.resolve();

  constructor(private readonly options: SharedSandboxOptions) {
    this.capacity = options.ports.length;
  }

  acquire = async (sessionId: string): Promise<SessionSandboxLease> => {
    const held = new Set(this.taken.values());
    const port = this.options.ports.find((candidate) => !held.has(candidate));
    if (port === undefined) throw new SessionCapacityError(this.capacity);
    this.taken.set(sessionId, port);
    let view: SandboxView;
    try {
      view = (await this.sandbox()).fork({ ports: [port] });
    } catch (error) {
      this.taken.delete(sessionId);
      throw error;
    }
    let released: Promise<void> | undefined;
    const release = (): Promise<void> => {
      released ??= this.release(view, sessionId, port);
      return released;
    };
    return { sandboxSession: view, suspend: release, close: release };
  };

  shutdown = async (): Promise<void> => {
    this.taken.clear();
    if (this.options.stopWhenUnused === true) await this.stop();
  };

  /** The sandbox, opened when no session holds it yet, or after it was stopped. */
  private sandbox(): Promise<ForkableSandbox> {
    if (this.opened === undefined) {
      const opening = this.stopping.then(() => this.options.open());
      this.opened = opening;
      // A failure is not remembered: the next session opens it again.
      opening.catch(() => {
        if (this.opened === opening) this.opened = undefined;
      });
    }
    return this.opened;
  }

  private async release(view: SandboxView, sessionId: string, port: number): Promise<void> {
    try {
      await view.release();
    } finally {
      if (this.taken.get(sessionId) === port) this.taken.delete(sessionId);
      if (this.options.stopWhenUnused === true && this.taken.size === 0) await this.stop();
    }
  }

  private stop(): Promise<void> {
    const opened = this.opened;
    this.opened = undefined;
    this.stopping = (async () => {
      const running = await opened?.catch(() => undefined);
      await running?.stop();
    })();
    return this.stopping;
  }
}
