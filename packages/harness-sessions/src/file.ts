/**
 * `ai-sdk-harness-sessions/file`: a session store in JSON files, so that sessions outlive a restart
 * with nothing to install. Node.js only.
 */
export { createFileSessionStore } from './store/file-session-store.js';
