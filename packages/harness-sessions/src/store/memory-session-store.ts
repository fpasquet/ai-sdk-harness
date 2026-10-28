import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import type { SessionRecord, SessionSummary } from '../definitions/session.js';
import type { SessionOwnership, SessionStore } from '../definitions/store.js';

export interface MemorySessionStoreOptions {
  /**
   * Lets several managers of this process share the store, with the lease methods: what a store
   * on a database does for the instances of an application. For tests, and as a reference.
   */
  shared?: boolean;
}

/**
 * A {@link SessionStore} in this process's memory: sessions are lost when it stops. For a
 * prototype, tests, or an application whose sessions need not outlive it.
 *
 * Records are copied in and out, so a caller changing one never changes what the store keeps.
 */
export function createMemorySessionStore<METADATA = unknown>({
  shared = false,
}: MemorySessionStoreOptions = {}): SessionStore<METADATA> {
  const records = new Map<string, SessionRecord<METADATA>>();
  const resumeStates = new Map<string, HarnessAgentResumeSessionState>();
  const ownerships = new Map<string, SessionOwnership>();

  const store: SessionStore<METADATA> = {
    save: (record, resumeState) => {
      records.set(record.id, structuredClone(record));
      if (resumeState === undefined) resumeStates.delete(record.id);
      else resumeStates.set(record.id, structuredClone(resumeState));
      return Promise.resolve();
    },
    get: (id) => {
      const record = records.get(id);
      return Promise.resolve(record === undefined ? undefined : structuredClone(record));
    },
    list: () =>
      Promise.resolve(
        [...records.values()].map(({ messages: _messages, ...summary }) =>
          structuredClone(summary as SessionSummary<METADATA>),
        ),
      ),
    getResumeState: (id) => {
      const state = resumeStates.get(id);
      return Promise.resolve(state === undefined ? undefined : structuredClone(state));
    },
    delete: (id) => {
      records.delete(id);
      resumeStates.delete(id);
      ownerships.delete(id);
      return Promise.resolve();
    },
  };
  return shared ? { ...store, ...ownershipMethods(ownerships) } : store;
}

/** The lease methods of the memory store, on its ownerships. */
function ownershipMethods(
  ownerships: Map<string, SessionOwnership>,
): Required<
  Pick<SessionStore, 'getOwnership' | 'releaseOwnership' | 'renewOwnerships' | 'writeOwnership'>
> {
  return {
    getOwnership: (id) => {
      const ownership = ownerships.get(id);
      return Promise.resolve(ownership === undefined ? undefined : structuredClone(ownership));
    },
    writeOwnership: (id, ownership, expectedVersion) => {
      const current = ownerships.get(id);
      const matches =
        expectedVersion === undefined
          ? current === undefined
          : current?.version === expectedVersion;
      if (matches) ownerships.set(id, structuredClone(ownership));
      return Promise.resolve(matches);
    },
    renewOwnerships: (owner, expiresAt) => {
      for (const ownership of ownerships.values()) {
        if (ownership.owner === owner) ownership.expiresAt = new Date(expiresAt);
      }
      return Promise.resolve();
    },
    releaseOwnership: (id, owner) => {
      if (ownerships.get(id)?.owner === owner) ownerships.delete(id);
      return Promise.resolve();
    },
  };
}
