import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionManager, SessionManagerOptions } from '../index.js';

import { FakeAgent, fakeSandboxes, leasingStore, readAll, until } from '../../test/fakes.js';
import {
  createMemorySessionStore,
  createSessionManager,
  SessionConflictError,
  SessionOwnedElsewhereError,
} from '../index.js';

interface Metadata {
  title: string;
}

describe('several managers sharing a store', () => {
  let agent: FakeAgent;
  let fake: ReturnType<typeof fakeSandboxes>;
  let store: ReturnType<typeof leasingStore<Metadata>>;
  let managers: SessionManager<Metadata>[];

  const manager = (managerId: string, options: Partial<SessionManagerOptions<Metadata>> = {}) => {
    const created = createSessionManager<Metadata>({
      agent: () => agent,
      sandboxes: fake.sandboxes,
      store,
      managerId,
      leaseTtlMs: 60,
      onError: () => undefined,
      ...options,
    });
    managers.push(created);
    return created;
  };

  const ready = async (sessions: SessionManager<Metadata>, id: string) => {
    await sessions.create({ id, metadata: { title: id } });
    await until(async () => (await sessions.get(id))?.status === 'idle');
  };

  const turn = async (sessions: SessionManager<Metadata>, id: string, message: string) => {
    const started = await sessions.send(id, { message });
    await readAll(started.stream);
    return started.done;
  };

  beforeEach(() => {
    agent = new FakeAgent();
    fake = fakeSandboxes();
    store = leasingStore<Metadata>();
    managers = [];
  });

  afterEach(async () => {
    await Promise.all(managers.map((sessions) => sessions.shutdown()));
  });

  it('leaves the live sessions of another manager alone when it starts', async () => {
    const a = manager('a');
    await ready(a, 's1');

    const b = manager('b');
    await b.list();

    expect((await b.get('s1'))?.status).toBe('idle');
    expect(store.owners.get('s1')).toBe('a');
    expect((await turn(a, 's1', 'hello')).status).toBe('idle');
  });

  it('sends what a session run by another manager is asked to that one', async () => {
    const a = manager('a');
    const b = manager('b');
    await ready(a, 's1');

    const refused = b.send('s1', { message: 'hello' });

    await expect(refused).rejects.toThrow(SessionOwnedElsewhereError);
    await expect(refused).rejects.toMatchObject({ owner: 'a', status: 'idle' });
    expect(SessionConflictError.isInstance(await refused.catch((error: unknown) => error))).toBe(
      true,
    );
    for (const call of [
      () => b.interrupt('s1'),
      () => b.suspend('s1'),
      () => b.close('s1'),
      () => b.update('s1', { metadata: { title: 'Changed' } }),
    ]) {
      await expect(call()).rejects.toMatchObject({ owner: 'a' });
    }
    expect((await a.get('s1'))?.metadata.title).toBe('s1');
  });

  it('resumes a session another manager suspended, which then runs it no more', async () => {
    const a = manager('a');
    const b = manager('b');
    await ready(a, 's1');
    await a.suspend('s1');
    expect(store.owners.has('s1')).toBe(false);

    const session = await turn(b, 's1', 'hello');

    expect(session.status).toBe('idle');
    expect(store.owners.get('s1')).toBe('b');
    await expect(a.send('s1', { message: 'again' })).rejects.toMatchObject({ owner: 'b' });
  });

  it('refuses a session another manager is creating', async () => {
    const a = manager('a');
    await store.claimSession('s1', 'b');
    await store.renewLease('b', 60_000);

    await expect(a.create({ id: 's1', metadata: { title: 'One' } })).rejects.toMatchObject({
      owner: 'b',
    });
  });

  it('closes and lets go of a suspended session, whichever manager suspended it', async () => {
    const a = manager('a');
    const b = manager('b');
    await ready(a, 's1');
    await a.suspend('s1');

    const closed = await b.close('s1');

    expect(closed.status).toBe('closed');
    expect(fake.events).toContain('discard s1');
    expect(store.owners.has('s1')).toBe(false);
  });

  it('interrupts the sessions of a manager that crashed, once its lease expired', async () => {
    const a = manager('a');
    const b = manager('b');
    await ready(a, 's1');
    await ready(a, 's2');

    store.crash('a');

    // Taken over once a's lease expired, without anyone asking.
    await until(async () => (await b.get('s1'))?.status === 'interrupted', 1000);
    expect((await b.get('s1'))?.error).toMatch(/without suspending/);
    await expect(b.send('s2', { message: 'hello' })).rejects.toMatchObject({
      status: 'interrupted',
    });
    expect(store.owners.size).toBe(0);
  });

  it('interrupts, when it starts, the sessions of a manager that crashed', async () => {
    const a = manager('a');
    await ready(a, 's1');
    store.crash('a');
    await new Promise((resolve) => setTimeout(resolve, 80));

    const b = manager('b');

    await until(async () => (await b.get('s1'))?.status === 'interrupted');
  });

  it('refuses a store that gives some of the lease methods only', () => {
    const { renewLease: _renew, ...partial } = leasingStore<Metadata>();

    expect(() => manager('a', { store: partial })).toThrow(/all three/);
    expect(manager('b', { store: createMemorySessionStore() }).managerId).toBe('b');
  });
});
