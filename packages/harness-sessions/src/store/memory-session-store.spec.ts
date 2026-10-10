import { describe, expect, it } from 'vitest';

import type { SessionRecord } from '../definitions/session.js';

import { resumeState } from '../../test/fakes.js';
import { createMemorySessionStore } from './memory-session-store.js';

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

describe('createMemorySessionStore', () => {
  it('keeps sessions, and lists them without their messages', async () => {
    const store = createMemorySessionStore<{ title: string }>();

    await store.save(record('a'));
    await store.save(record('b'));

    expect(await store.get('a')).toEqual(record('a'));
    expect(await store.get('ghost')).toBeUndefined();
    expect((await store.list()).map((summary) => [summary.id, 'messages' in summary])).toEqual([
      ['a', false],
      ['b', false],
    ]);
  });

  it('keeps the resume state of a suspended session only, until it is written without it', async () => {
    const store = createMemorySessionStore();

    await store.save({ ...record('a'), status: 'suspended' }, resumeState('a'));
    expect(await store.getResumeState('a')).toEqual(resumeState('a'));

    await store.save(record('a'));
    expect(await store.getResumeState('a')).toBeUndefined();
  });

  it('copies what it keeps, in and out', async () => {
    const store = createMemorySessionStore<{ title: string }>();
    const written = record('a');

    await store.save(written);
    written.metadata.title = 'changed';
    const read = await store.get('a');
    read!.metadata.title = 'changed too';

    expect((await store.get('a'))?.metadata.title).toBe('a');
  });

  it('forgets a deleted session and its resume state', async () => {
    const store = createMemorySessionStore();
    await store.save(record('a'), resumeState('a'));

    await store.delete('a');

    expect(await store.get('a')).toBeUndefined();
    expect(await store.getResumeState('a')).toBeUndefined();
  });
});
