/**
 * `ai-sdk-harness-sessions/memory`: a session store in this process's memory, the manager's
 * default. Import it to give options (`shared`), or to start from it in tests.
 */
export { createMemorySessionStore } from './store/memory-session-store.js';
export type { MemorySessionStoreOptions } from './store/memory-session-store.js';
