import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import { describe, expect, it } from 'vitest';

import { sandboxPerSession } from './sandbox-per-session.js';

describe('sandboxPerSession', () => {
  const setup = () => {
    const events: string[] = [];
    const sandboxOf = (id: string) =>
      ({
        id,
        stop: () => {
          events.push(`stop ${id}`);
          return Promise.resolve();
        },
        destroy: () => {
          events.push(`destroy ${id}`);
          return Promise.resolve();
        },
      }) as unknown as HarnessV1NetworkSandboxSession;
    const sandboxes = sandboxPerSession({
      create: (id) => {
        events.push(`create ${id}`);
        return Promise.resolve(sandboxOf(id));
      },
      resume: (id) => {
        events.push(`resume ${id}`);
        return Promise.resolve(sandboxOf(id));
      },
      maxSessions: 3,
    });
    return { events, sandboxes };
  };

  it('creates a sandbox for a new session, and reattaches to it on a resume', async () => {
    const { events, sandboxes } = setup();

    const created = await sandboxes.acquire('a', { resume: false });
    const resumed = await sandboxes.acquire('a', { resume: true });

    expect(sandboxes.capacity).toBe(3);
    expect(created.sandboxSession.id).toBe('a');
    expect(resumed.sandboxSession.id).toBe('a');
    expect(events).toEqual(['create a', 'resume a']);
  });

  it('stops the sandbox of a suspended session, and destroys that of a closed one', async () => {
    const { events, sandboxes } = setup();
    const lease = await sandboxes.acquire('a', { resume: false });

    await lease.suspend();
    await lease.close();
    await sandboxes.discard?.('b');

    expect(events).toEqual(['create a', 'stop a', 'destroy a', 'resume b', 'destroy b']);
  });

  it('takes any number of sessions unless told otherwise', () => {
    const sandboxes = sandboxPerSession({
      create: () => Promise.reject(new Error('unused')),
      resume: () => Promise.reject(new Error('unused')),
    });

    expect(sandboxes.capacity).toBeUndefined();
  });
});
