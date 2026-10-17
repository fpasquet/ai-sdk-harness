import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import type { SessionRecord, SessionSummary } from './session.js';

/**
 * Where sessions are kept, so they outlive the process: their conversation to read, and what a
 * suspended one needs to resume. `createMemorySessionStore()` keeps them in memory; implement it
 * on your database to keep them across restarts.
 *
 * A session's resume state is kept apart from it: it holds secrets (the token of the harness
 * bridge, the placeholders of the credentials), and is never shown. It exists exactly as long as
 * the session is `suspended`.
 */
export interface SessionStore<METADATA = unknown> {
  /**
   * Writes the whole session, creating it the first time. `resumeState` comes with a `suspended`
   * session; any kept one is dropped otherwise. The manager writes one session at a time, in
   * order.
   */
  save(
    record: SessionRecord<METADATA>,
    resumeState?: HarnessAgentResumeSessionState,
  ): Promise<void>;
  get(id: string): Promise<SessionRecord<METADATA> | undefined>;
  /** Every session, without its messages. */
  list(): Promise<SessionSummary<METADATA>[]>;
  /** What a suspended session needs to resume. */
  getResumeState(id: string): Promise<HarnessAgentResumeSessionState | undefined>;
  /** Forgets the session and its resume state, and who holds it. */
  delete(id: string): Promise<void>;
  /**
   * Optional, with `renewLease` and `releaseSession`: lets several managers share the store — the
   * instances of an application behind a load balancer, or a new version deployed beside the old
   * one. A manager holds each session it runs, and keeps its lease alive while it runs: another
   * manager leaves its sessions alone, and takes them over once its lease expired.
   *
   * Makes `owner` hold the session `id`, in one atomic step (a compare-and-set on a database row),
   * unless another manager whose lease has not expired holds it. The session need not be saved
   * yet: `create()` takes it before writing it.
   */
  claimSession?(id: string, owner: string): Promise<SessionClaim>;
  /**
   * Keeps the lease of the manager `owner` alive for `ttlMs` milliseconds from now, by the store's
   * clock: what decides whether the sessions it holds may be taken over.
   */
  renewLease?(owner: string, ttlMs: number): Promise<void>;
  /** Lets go of the session `id`, when `owner` holds it. */
  releaseSession?(id: string, owner: string): Promise<void>;
}

/** What `claimSession` made of a claim. */
export type SessionClaim =
  | {
      claimed: false;
      /** The manager that holds the session, its lease alive. */
      owner: string;
    }
  | {
      claimed: true;
      /**
       * Who held the session before: `null` when nobody did, the claiming manager itself when it
       * held it already, or a manager whose lease expired.
       */
      previousOwner: null | string;
    };
