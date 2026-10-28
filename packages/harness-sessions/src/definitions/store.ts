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
  /** Forgets the session, its resume state, and who holds it. */
  delete(id: string): Promise<void>;
  /**
   * Optional, with `writeOwnership`, `renewOwnerships` and `releaseOwnership`: lets several
   * managers share the store — the instances of an application behind a load balancer, or a new
   * version deployed beside the old one. A manager holds each session it runs, and renews its
   * lease while it runs: another manager leaves its sessions alone, and takes them over once the
   * lease expired. Each method is one plain read or write of a row, keyed by session: what any ORM
   * does.
   *
   * Who holds the session `id`, if anyone.
   */
  getOwnership?(id: string): Promise<SessionOwnership | undefined>;
  /**
   * Writes who holds the session `id`, in one atomic step, and says whether it did. Without
   * `expectedVersion`, creates it, unless one exists already: an insert, refused by the primary
   * key. With it, replaces the one whose `version` is `expectedVersion`, unless it changed
   * meanwhile: an update filtered on the id and that version. The session need not be saved yet:
   * `create()` takes it before writing it.
   */
  writeOwnership?(
    id: string,
    ownership: SessionOwnership,
    expectedVersion?: number,
  ): Promise<boolean>;
  /** Moves the expiry of every session `owner` holds to `expiresAt`: an update filtered on `owner`. */
  renewOwnerships?(owner: string, expiresAt: Date): Promise<void>;
  /** Forgets who holds the session `id`, when it is `owner`: a delete filtered on both. */
  releaseOwnership?(id: string, owner: string): Promise<void>;
}

/** Who holds a session, among the managers sharing a store. */
export interface SessionOwnership {
  /** The `managerId` of the manager that runs it. */
  owner: string;
  /**
   * When its lease runs out, unless its manager renews it: another manager may take the session
   * over then. Read on the managers' clocks.
   */
  expiresAt: Date;
  /** Grows by one each time the session changes hands: what `writeOwnership` compares. */
  version: number;
}
