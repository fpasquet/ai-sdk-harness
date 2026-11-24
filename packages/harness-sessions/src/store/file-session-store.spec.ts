import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../definitions/session.js';

import { resumeState } from '../../test/fakes.js';
import { createFileSessionStore } from './file-session-store.js';
import { sessionStoreChecks } from './session-store-checks.js';

const root = mkdtempSync(join(tmpdir(), 'file-session-store-'));
let directories = 0;
const directory = () => join(root, `store-${(directories += 1)}`);

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(root, { recursive: true, force: true });
});

const record = (id: string): SessionRecord<{ title: string }> => ({
  id,
  status: 'idle',
  metadata: { title: id },
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  turns: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
});

describe('sessionStoreChecks, on the file store', () => {
  for (const { name, run } of sessionStoreChecks(() => createFileSessionStore(directory()))) {
    it(name, run);
  }
});

describe('createFileSessionStore', () => {
  it('keeps the sessions across stores of the same directory, as across restarts', async () => {
    const path = directory();
    await createFileSessionStore(path).save(record('a'));

    expect(await createFileSessionStore(path).get('a')).toEqual(record('a'));
  });

  it('lists nothing before the first write, without creating the directory', async () => {
    const path = directory();

    expect(await createFileSessionStore(path).list()).toEqual([]);
    expect(() => statSync(path)).toThrow();
  });

  it('keeps the directory and the resume states to their owner', async () => {
    const path = directory();
    await createFileSessionStore(path).save(
      { ...record('a'), status: 'suspended' },
      resumeState('a'),
    );

    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, 'a.resume.json')).mode & 0o777).toBe(0o600);
  });

  it('names the files of any id safely, and leaves no temporary file behind', async () => {
    const path = directory();
    const store = createFileSessionStore(path);

    await store.save(record('../a/b'));

    expect(await store.get('../a/b')).toEqual(record('../a/b'));
    expect(readdirSync(path)).toEqual(['%2E%2E%2Fa%2Fb.json']);
  });

  it('keeps apart a session named like the resume state of another', async () => {
    const store = createFileSessionStore(directory());
    await store.save({ ...record('a'), status: 'suspended' }, resumeState('a'));
    await store.save(record('a.resume'));

    expect(await store.getResumeState('a')).toEqual(resumeState('a'));
    expect((await store.list()).map(({ id }) => id).sort()).toEqual(['a', 'a.resume']);
  });

  it('lists the sessions alone, whatever else the directory holds', async () => {
    const path = directory();
    const store = createFileSessionStore(path);
    await store.save({ ...record('a'), status: 'suspended' }, resumeState('a'));
    writeFileSync(join(path, 'notes.txt'), 'not a session');

    expect((await store.list()).map(({ id }) => id)).toEqual(['a']);
  });
});
