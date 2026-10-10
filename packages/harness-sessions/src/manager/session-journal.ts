import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import type { SessionEvent } from '../definitions/manager.js';
import type { SessionRecord } from '../definitions/session.js';
import type { SessionStore } from '../definitions/store.js';

import { summaryOf } from './live-session.js';

type Report = (action: string, sessionId?: string) => (error: unknown) => void;

/**
 * Where every change of a session goes: to the store, one write of a session after the other, and
 * to the subscribers.
 */
export class SessionJournal<METADATA> {
  /** The last write of each session: one session is written at a time, in order. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: SessionEvent<METADATA>) => void>();

  constructor(
    private readonly store: SessionStore<METADATA>,
    private readonly report: Report,
  ) {}

  subscribe(listener: (event: SessionEvent<METADATA>) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Tells the subscribers the session changed. */
  updated(record: SessionRecord<METADATA>): void {
    this.emit({ type: 'updated', session: summaryOf(record) });
  }

  /**
   * Queues a write of the whole session, as it stands now. One that fails is reported: the next
   * write writes it all again.
   */
  write(
    record: SessionRecord<METADATA>,
    resumeState?: HarnessAgentResumeSessionState,
  ): Promise<void> {
    const snapshot = structuredClone(record);
    const written = (this.writes.get(record.id) ?? Promise.resolve())
      .then(() => this.store.save(snapshot, resumeState))
      .catch(this.report('write', record.id));
    this.writes.set(record.id, written);
    return written;
  }

  /** Forgets the session, once its writes are done, and tells the subscribers. */
  async delete(id: string): Promise<void> {
    await this.writes.get(id);
    this.writes.delete(id);
    await this.store.delete(id);
    this.emit({ type: 'deleted', sessionId: id });
  }

  /** Resolves once every queued write is done. */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  private emit(event: SessionEvent<METADATA>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.report('listener')(error);
      }
    }
  }
}
