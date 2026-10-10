import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

import { describe, expect, it, vi } from 'vitest';

import type { ForkableSandbox, SandboxView } from './shared-sandbox.js';

import { SessionCapacityError } from '../errors/session-capacity-error.js';
import { sharedSandbox } from './shared-sandbox.js';

/** A sandbox that records its views, and what is done with them. */
function fakeSandbox(events: string[]): ForkableSandbox {
  return {
    id: 'shared',
    stop: () => {
      events.push('stop');
      return Promise.resolve();
    },
    fork: ({ ports }: { ports: readonly number[] }) => {
      events.push(`fork ${ports.join(',')}`);
      const view = {
        id: 'shared',
        ports,
        release: () => {
          events.push(`release ${ports.join(',')}`);
          return Promise.resolve();
        },
      };
      return view as unknown as SandboxView;
    },
  } as unknown as ForkableSandbox;
}

describe('sharedSandbox', () => {
  it('opens the sandbox once, and gives each session a view with a port of its own', async () => {
    const events: string[] = [];
    const open = vi.fn(() => Promise.resolve(fakeSandbox(events)));
    const sandboxes = sharedSandbox({ open, ports: [4001, 4002] });

    const first = await sandboxes.acquire('a', { resume: false });
    const second = await sandboxes.acquire('b', { resume: true });

    expect(sandboxes.capacity).toBe(2);
    expect(open).toHaveBeenCalledOnce();
    expect(first.sandboxSession.ports).toEqual([4001]);
    expect(second.sandboxSession.ports).toEqual([4002]);
  });

  it('refuses a session when every port is taken, and hands a port back when its view is released', async () => {
    const events: string[] = [];
    const sandboxes = sharedSandbox({
      open: () => Promise.resolve(fakeSandbox(events)),
      ports: [4001],
    });
    const first = await sandboxes.acquire('a', { resume: false });

    await expect(sandboxes.acquire('b', { resume: false })).rejects.toThrow(SessionCapacityError);
    await first.suspend();
    await first.close();
    const second = await sandboxes.acquire('b', { resume: false });

    expect(second.sandboxSession.ports).toEqual([4001]);
    expect(events).toEqual(['fork 4001', 'release 4001', 'fork 4001']);
  });

  it('stops the sandbox once no session holds it, and opens it again for the next one', async () => {
    const events: string[] = [];
    const open = vi.fn(() => Promise.resolve(fakeSandbox(events)));
    const sandboxes = sharedSandbox({ open, ports: [4001, 4002], stopWhenUnused: true });
    const first = await sandboxes.acquire('a', { resume: false });
    const second = await sandboxes.acquire('b', { resume: false });

    await first.suspend();
    expect(events).not.toContain('stop');
    await second.close();
    expect(events.at(-1)).toBe('stop');

    await sandboxes.acquire('a', { resume: true });
    expect(open).toHaveBeenCalledTimes(2);
    await sandboxes.shutdown?.();
    expect(events.at(-1)).toBe('stop');
  });

  it('keeps the sandbox running at shutdown unless told to stop it', async () => {
    const events: string[] = [];
    const sandboxes = sharedSandbox({
      open: () => Promise.resolve(fakeSandbox(events)),
      ports: [4001],
    });
    await sandboxes.acquire('a', { resume: false });

    await sandboxes.shutdown?.();

    expect(events).toEqual(['fork 4001']);
  });

  it('forgets a sandbox that failed to open, and frees the port it took', async () => {
    const events: string[] = [];
    const open = vi
      .fn<() => Promise<ForkableSandbox>>()
      .mockRejectedValueOnce(new Error('no sandbox'))
      .mockResolvedValue(fakeSandbox(events));
    const sandboxes = sharedSandbox({ open, ports: [4001] });

    await expect(sandboxes.acquire('a', { resume: false })).rejects.toThrow('no sandbox');
    const lease = await sandboxes.acquire('a', { resume: false });

    expect(lease.sandboxSession.ports).toEqual([4001]);
  });

  it('needs ports, each listed once', () => {
    const open = () => Promise.resolve({} as ForkableSandbox);

    expect(() => sharedSandbox({ open, ports: [] })).toThrow(TypeError);
    expect(() => sharedSandbox({ open, ports: [4001, 4001] })).toThrow(TypeError);
  });

  it('accepts the sandboxes of ai-sdk-sandbox-sbx and ai-sdk-sandbox-cloud-run', () => {
    // A type check: a network sandbox session with fork() is a ForkableSandbox.
    const sandbox = {} as HarnessV1NetworkSandboxSession & {
      fork(options: { ports: readonly number[] }): SandboxView;
    };
    expect(sharedSandbox({ open: () => Promise.resolve(sandbox), ports: [1] })).toBeDefined();
  });
});
