import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { SessionStore } from '../definitions/store.js';

/** Seals a session's resume state before a store keeps it, and opens it again. */
export interface ResumeStateCipher {
  /** `plaintext`, the resume state as JSON, sealed for the session `sessionId` alone. */
  seal(plaintext: string, sessionId: string): Promise<string>;
  /** What `seal` sealed for `sessionId`; throws when it was sealed for another session. */
  open(sealed: string, sessionId: string): Promise<string>;
}

/** What the store keeps in place of a resume state. */
interface SealedResumeState {
  sealed: string;
}

/**
 * `store`, its resume states sealed by `cipher` before it keeps them: they hold secrets, the token
 * of the harness bridge and the placeholders of the credentials. The store keeps `{ sealed }` in
 * their place, a JSON object like any other.
 */
export function withEncryptedResumeState<METADATA>(
  store: SessionStore<METADATA>,
  cipher: ResumeStateCipher,
): SessionStore<METADATA> {
  return {
    ...store,
    save: async (record, resumeState) => {
      if (resumeState === undefined) return store.save(record);
      const sealed: SealedResumeState = {
        sealed: await cipher.seal(JSON.stringify(resumeState), record.id),
      };
      return store.save(record, sealed as unknown as HarnessAgentResumeSessionState);
    },
    getResumeState: async (id) => {
      const kept = (await store.getResumeState(id)) as SealedResumeState | undefined;
      if (kept === undefined) return undefined;
      return JSON.parse(await cipher.open(kept.sealed, id)) as HarnessAgentResumeSessionState;
    },
  };
}

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * A {@link ResumeStateCipher} with AES-256-GCM and one key of 32 bytes — raw, or base64 — kept out
 * of the database: an environment variable, a secret manager. Each state is sealed for its session,
 * its id authenticated with it: a state copied onto another session does not open.
 */
export function aesGcmCipher(key: string | Uint8Array): ResumeStateCipher {
  const secret = typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.from(key);
  if (secret.length !== 32) {
    throw new TypeError(`An AES-256-GCM key is 32 bytes; this one is ${secret.length}.`);
  }
  return {
    seal: (plaintext, sessionId) =>
      settle(() => {
        const iv = randomBytes(12);
        const cipher = createCipheriv(ALGORITHM, secret, iv).setAAD(Buffer.from(sessionId));
        const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const parts = [iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64'));
        return [VERSION, ...parts].join('.');
      }),
    open: (sealed, sessionId) =>
      settle(() => {
        const [version, iv = '', tag = '', data = ''] = sealed.split('.');
        if (version !== VERSION) throw new Error(`Unknown sealed resume state: ${version ?? ''}.`);
        const decipher = createDecipheriv(ALGORITHM, secret, Buffer.from(iv, 'base64'))
          .setAAD(Buffer.from(sessionId))
          .setAuthTag(Buffer.from(tag, 'base64'));
        const opened = Buffer.concat([
          decipher.update(Buffer.from(data, 'base64')),
          decipher.final(),
        ]);
        return opened.toString('utf8');
      }),
  };
}

/** What `run` returns, or throws, as a promise. */
function settle<T>(run: () => T): Promise<T> {
  return new Promise((resolve) => resolve(run()));
}
