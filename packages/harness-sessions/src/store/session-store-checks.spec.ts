import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { SessionStore } from '../definitions/store.js';

import { aesGcmCipher, withEncryptedResumeState } from './encrypted-resume-state.js';
import { createMemorySessionStore } from './memory-session-store.js';
import { sessionStoreChecks } from './session-store-checks.js';

const stores: [string, () => SessionStore][] = [
  ['the memory store', () => createMemorySessionStore()],
  ['the memory store shared between managers', () => createMemorySessionStore({ shared: true })],
  [
    'a store whose resume states are sealed',
    () => withEncryptedResumeState(createMemorySessionStore(), aesGcmCipher(randomBytes(32))),
  ],
];

describe.each(stores)('sessionStoreChecks, on %s', (_name, create) => {
  for (const { name, run } of sessionStoreChecks(create)) it(name, run);
});

describe('sessionStoreChecks', () => {
  it('fails a store that lists the sessions with their messages', async () => {
    const memory = createMemorySessionStore();
    const leaky: SessionStore = {
      ...memory,
      list: async () =>
        Promise.all((await memory.list()).map(({ id }) => memory.get(id))).then((records) =>
          records.filter((record) => record !== undefined),
        ),
    };
    const check = sessionStoreChecks(() => leaky).find(({ name }) => name.startsWith('lists'))!;

    await expect(check.run()).rejects.toThrow(/without messages/);
  });
});

describe('withEncryptedResumeState', () => {
  it('keeps a sealed resume state, never the secrets it holds', async () => {
    const inner = createMemorySessionStore();
    const store = withEncryptedResumeState(inner, aesGcmCipher(randomBytes(32).toString('base64')));
    const state = { token: 'bridge-secret' } as never;
    const record = await sessionStoreRecord('s1');

    await store.save(record, state);

    expect(JSON.stringify(await inner.getResumeState('s1'))).not.toContain('bridge-secret');
    expect(await store.getResumeState('s1')).toEqual(state);
  });
});

describe('aesGcmCipher', () => {
  it('opens a state for the session it was sealed for only', async () => {
    const cipher = aesGcmCipher(randomBytes(32));
    const sealed = await cipher.seal('{"token":"secret"}', 'one');

    expect(await cipher.open(sealed, 'one')).toBe('{"token":"secret"}');
    await expect(cipher.open(sealed, 'two')).rejects.toThrow();
    await expect(aesGcmCipher(randomBytes(32)).open(sealed, 'one')).rejects.toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => aesGcmCipher(randomBytes(16))).toThrow(/32 bytes/);
  });
});

async function sessionStoreRecord(id: string) {
  const memory = createMemorySessionStore();
  await memory.save({
    id,
    status: 'suspended',
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    messages: [],
  });
  return (await memory.get(id))!;
}
