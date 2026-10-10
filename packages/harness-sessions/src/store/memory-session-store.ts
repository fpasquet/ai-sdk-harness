import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import type { SessionRecord, SessionSummary } from '../definitions/session.js';
import type { SessionStore } from '../definitions/store.js';

/**
 * A {@link SessionStore} in this process's memory: sessions are lost when it stops. For a
 * prototype, tests, or an application whose sessions need not outlive it.
 *
 * Records are copied in and out, so a caller changing one never changes what the store keeps.
 */
export function createMemorySessionStore<METADATA = unknown>(): SessionStore<METADATA> {
  const records = new Map<string, SessionRecord<METADATA>>();
  const resumeStates = new Map<string, HarnessAgentResumeSessionState>();

  return {
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
      return Promise.resolve();
    },
  };
}
