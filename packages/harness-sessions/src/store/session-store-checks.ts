import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { SessionRecord } from '../definitions/session.js';
import type { SessionOwnership, SessionStore } from '../definitions/store.js';

/** One check of a store: run it as a test of your test runner. */
export interface SessionStoreCheck {
  name: string;
  run: () => Promise<void>;
}

/** A store, or a promise of one: a new one, or a clean one, for each check. */
type StoreFactory = () => Promise<SessionStore> | SessionStore;

const record = (id: string, title = 'A session'): SessionRecord => ({
  id,
  status: 'idle',
  metadata: { title },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  turns: 1,
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi, how can I help?' }] },
  ],
});

/** A resume state as the harness gives one: what matters is that it comes back the same. */
const resumeState = {
  harness: 'claude-code',
  token: 'secret',
} as unknown as HarnessAgentResumeSessionState;

const ownership = (owner: string, version: number, inMs = 60_000): SessionOwnership => ({
  owner,
  expiresAt: new Date(Date.now() + inMs),
  version,
});

/** What a store gives back of an ownership, its date read as a date whatever form it comes in. */
async function ownershipOf(store: SessionStore, id: string) {
  const kept = await store.getOwnership?.(id);
  if (kept === undefined) return undefined;
  return { owner: kept.owner, version: kept.version, expiresAt: new Date(kept.expiresAt) };
}

const SESSION_CHECKS: [string, (store: SessionStore) => Promise<void>][] = [
  [
    'saves a session, then gives it back whole',
    async (store) => {
      const id = randomUUID();
      await store.save(record(id));
      assert.deepEqual(await store.get(id), record(id));
      assert.equal(await store.get(randomUUID()), undefined);
    },
  ],
  [
    'writes a session again, whole',
    async (store) => {
      const id = randomUUID();
      await store.save(record(id));
      await store.save({ ...record(id, 'Renamed'), status: 'busy', messages: [] });
      assert.deepEqual(await store.get(id), {
        ...record(id, 'Renamed'),
        status: 'busy',
        messages: [],
      });
    },
  ],
  [
    'lists the sessions without their messages',
    async (store) => {
      const ids: string[] = [randomUUID(), randomUUID()];
      for (const id of ids) await store.save(record(id));
      const listed = (await store.list()).filter(({ id }) => ids.includes(id));
      assert.equal(listed.length, 2);
      for (const summary of listed) {
        assert.equal('messages' in summary, false, 'list() gives the sessions without messages');
        const { messages: _messages, ...expected } = record(summary.id);
        assert.deepEqual(summary, expected);
      }
    },
  ],
  [
    'keeps a resume state with a suspended session only',
    async (store) => {
      const id = randomUUID();
      await store.save({ ...record(id), status: 'suspended' }, resumeState);
      assert.deepEqual(await store.getResumeState(id), resumeState);
      await store.save(record(id));
      assert.equal(await store.getResumeState(id), undefined);
    },
  ],
  [
    'forgets a deleted session and its resume state',
    async (store) => {
      const id = randomUUID();
      await store.save({ ...record(id), status: 'suspended' }, resumeState);
      await store.delete(id);
      assert.equal(await store.get(id), undefined);
      assert.equal(await store.getResumeState(id), undefined);
      assert.equal(
        (await store.list()).some((summary) => summary.id === id),
        false,
      );
    },
  ],
];

const OWNERSHIP_CHECKS: [string, (store: Required<SessionStore>) => Promise<void>][] = [
  [
    'creates an ownership once: a second creation is refused',
    async (store) => {
      const id = randomUUID();
      assert.equal(await store.writeOwnership(id, ownership('a', 1)), true);
      assert.equal(await store.writeOwnership(id, ownership('b', 1)), false);
      assert.deepEqual(
        { ...(await ownershipOf(store, id)), expiresAt: undefined },
        {
          owner: 'a',
          version: 1,
          expiresAt: undefined,
        },
      );
    },
  ],
  [
    'replaces an ownership at the version read, and refuses a stale one',
    async (store) => {
      const id = randomUUID();
      await store.writeOwnership(id, ownership('a', 1));
      assert.equal(await store.writeOwnership(id, ownership('b', 2), 1), true);
      assert.equal(await store.writeOwnership(id, ownership('c', 2), 1), false);
      assert.equal((await ownershipOf(store, id))?.owner, 'b');
      assert.equal(await store.writeOwnership(randomUUID(), ownership('a', 2), 1), false);
    },
  ],
  [
    'lets one of two managers win the same session, never both',
    async (store) => {
      const id = randomUUID();
      await store.writeOwnership(id, ownership('a', 1));
      const won = await Promise.all(
        ['b', 'c'].map((owner) => store.writeOwnership(id, ownership(owner, 2), 1)),
      );
      assert.equal(won.filter(Boolean).length, 1);
    },
  ],
  [
    'keeps the expiry of an ownership, to the second at least',
    async (store) => {
      const id = randomUUID();
      const written = ownership('a', 1, 30_000);
      await store.writeOwnership(id, written);
      const kept = await ownershipOf(store, id);
      assert.ok(kept !== undefined && !Number.isNaN(kept.expiresAt.getTime()));
      assert.ok(Math.abs(kept.expiresAt.getTime() - written.expiresAt.getTime()) < 1000);
    },
  ],
  [
    'renews the ownerships of one manager, and of that manager only',
    async (store) => {
      const [mine, theirs] = [randomUUID(), randomUUID()];
      await store.writeOwnership(mine, ownership('a', 1, 1000));
      await store.writeOwnership(theirs, ownership('b', 1, 1000));
      const later = new Date(Date.now() + 120_000);
      await store.renewOwnerships('a', later);
      const [renewed, kept] = [await ownershipOf(store, mine), await ownershipOf(store, theirs)];
      assert.ok(renewed !== undefined && kept !== undefined);
      assert.ok(Math.abs(renewed.expiresAt.getTime() - later.getTime()) < 1000);
      assert.ok(kept.expiresAt.getTime() < later.getTime() - 60_000);
      assert.equal((await ownershipOf(store, mine))?.version, 1, 'a renewal changes no version');
    },
  ],
  [
    'releases an ownership for its owner only, and forgets it with the session',
    async (store) => {
      const id = randomUUID();
      await store.writeOwnership(id, ownership('a', 1));
      await store.releaseOwnership(id, 'b');
      assert.equal((await ownershipOf(store, id))?.owner, 'a');
      await store.releaseOwnership(id, 'a');
      assert.equal(await ownershipOf(store, id), undefined);
      const deleted = randomUUID();
      await store.save(record(deleted));
      await store.writeOwnership(deleted, ownership('a', 1));
      await store.delete(deleted);
      assert.equal(await ownershipOf(store, deleted), undefined);
    },
  ],
];

const isShared = (store: SessionStore): store is Required<SessionStore> =>
  typeof store.getOwnership === 'function';

/**
 * What a {@link SessionStore} must do, as checks to run with your test runner, against your
 * database: the five methods, then, when the store gives them, the lease methods that let several
 * managers share it. Each check uses sessions of its own; give it a clean store when your tests
 * want one.
 *
 * ```ts
 * for (const { name, run } of sessionStoreChecks(() => store)) it(name, run);
 * ```
 */
export function sessionStoreChecks(createStore: StoreFactory): SessionStoreCheck[] {
  const checks = SESSION_CHECKS.map(([name, check]) => ({
    name,
    run: async () => check(await createStore()),
  }));
  const shared = OWNERSHIP_CHECKS.map(([name, check]) => ({
    name,
    run: async () => {
      const store = await createStore();
      // A store without leases has one manager: nothing more to check.
      if (isShared(store)) await check(store);
    },
  }));
  return [...checks, ...shared];
}
