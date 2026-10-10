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
  /** Forgets the session and its resume state. */
  delete(id: string): Promise<void>;
}
