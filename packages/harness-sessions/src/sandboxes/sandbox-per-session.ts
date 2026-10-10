import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import type { SessionSandboxes } from '../definitions/sandboxes.js';

export interface SandboxPerSessionOptions {
  /** Creates the sandbox of a new session, named after it if you need to find it again. */
  create(
    sessionId: string,
    options: { abortSignal?: AbortSignal },
  ): Promise<HarnessV1NetworkSandboxSession>;
  /** Reattaches to the sandbox of a session, stopped when it was suspended. */
  resume(
    sessionId: string,
    options: { abortSignal?: AbortSignal },
  ): Promise<HarnessV1NetworkSandboxSession>;
  /** How many sessions, each with its running sandbox, may be live at once. Default: unlimited. */
  maxSessions?: number;
}

/**
 * A sandbox for each session: created with it, stopped when it is suspended, reattached when it
 * resumes, and destroyed when it is closed. Sessions share nothing: one may run code another must
 * never see.
 */
export function sandboxPerSession(options: SandboxPerSessionOptions): SessionSandboxes {
  return {
    ...(options.maxSessions !== undefined && { capacity: options.maxSessions }),
    acquire: async (sessionId, { resume, abortSignal }) => {
      const settings = { ...(abortSignal && { abortSignal }) };
      const sandboxSession = await (resume
        ? options.resume(sessionId, settings)
        : options.create(sessionId, settings));
      return {
        sandboxSession,
        suspend: async () => {
          await sandboxSession.stop();
        },
        close: async () => {
          await sandboxSession.destroy();
        },
      };
    },
    discard: async (sessionId) => {
      const sandboxSession = await options.resume(sessionId, {});
      await sandboxSession.destroy();
    },
  };
}
