import type { HarnessV1SandboxTemplate } from '@ai-sdk/harness';

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SupervisorHostModule from '../session/supervisor-host.js';
import type { SupervisorPlan } from '../session/supervisor-host.js';
import type * as SrtRuntimeModule from '../transport/srt-runtime.js';

import { TEST_BUILD } from '../../../test/build-helpers.js';
import { FakeManager } from '../../../test/fake-srt.js';
import { SrtError } from '../errors/srt-error.js';
import { SrtSandboxNotFoundError } from '../errors/srt-sandbox-not-found-error.js';
import { SrtRuntime } from '../transport/srt-runtime.js';
import {
  createSrtNetworkSandboxSession,
  resumeSrtNetworkSandboxSession,
} from './create-session.js';

const manager = new FakeManager();

// srt is faked, the supervisor run on this host from the test build.
vi.mock('../transport/srt-runtime.js', async (original) => {
  const actual = await original<typeof SrtRuntimeModule>();
  return { ...actual, srtRuntime: () => Promise.resolve(new actual.SrtRuntime(manager)) };
});
vi.mock('../session/supervisor-host.js', async (original) => {
  const actual = await original<typeof SupervisorHostModule>();
  class SupervisorHost extends actual.SupervisorHost {
    constructor(plan: SupervisorPlan) {
      super({ ...plan, build: TEST_BUILD });
    }
  }
  return { ...actual, SupervisorHost };
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ai-sdk-srt-create-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('createSrtNetworkSandboxSession', () => {
  it('creates a sandbox, runs its setup, then prepares its template', async () => {
    const prepare = vi.fn<HarnessV1SandboxTemplate['prepare']>(async ({ session }) => {
      await session.run({ command: 'echo baked > "$HOME/baked.txt"' });
    });

    const session = await createSrtNetworkSandboxSession({
      sandboxId: 'box',
      directory,
      ports: [4000],
      setup: ['echo set-up > "$HOME/setup.txt"'],
      template: { identity: 'test', prepare },
    });

    expect(session.id).toBe('box');
    expect(session.ports).toEqual([4000]);
    expect(session.defaultWorkingDirectory).toBe(join(directory, 'box', 'sandbox', 'workspace'));
    expect((await session.run({ command: 'cat ~/setup.txt ~/baked.txt' })).stdout).toBe(
      'set-up\nbaked\n',
    );
    expect(manager.wrapped.at(-1)?.customConfig?.filesystem?.allowWrite).toEqual([
      join(directory, 'box', 'sandbox'),
    ]);
    expect(session.allowedDomains).toContain('registry.npmjs.org');
    await session.stop();
  });

  it('gives a new sandbox an id of its own', async () => {
    const session = await createSrtNetworkSandboxSession({ directory, brokerCredentials: false });

    expect(session.id).toMatch(/^srt-[0-9a-f]{8}$/);
    expect(session.addRequestTransformations).toBeUndefined();
    await session.stop();
  });

  it('removes a sandbox whose setup fails', async () => {
    await expect(
      createSrtNetworkSandboxSession({
        sandboxId: 'broken',
        directory,
        setup: ['echo no >&2; exit 3'],
      }),
    ).rejects.toThrow(new SrtError('The setup command `echo no >&2; exit 3` failed (3): no'));

    expect(existsSync(join(directory, 'broken'))).toBe(false);
  });
});

describe('resumeSrtNetworkSandboxSession', () => {
  it('finds a sandbox again, with the rules it was created with', async () => {
    const created = await createSrtNetworkSandboxSession({
      sandboxId: 'kept',
      directory,
      allowedDomains: ['example.com'],
    });
    await created.writeTextFile({ path: 'note.txt', content: 'kept' });
    await created.stop();

    const resumed = await resumeSrtNetworkSandboxSession({ sandboxId: 'kept', directory });

    expect(await resumed.readTextFile({ path: 'note.txt' })).toBe('kept');
    expect(resumed.allowedDomains).toEqual(['example.com']);
    expect(resumed).not.toBe(created);
    expect(new SrtRuntime(manager).isolatesNetworks).toBe(false);
    await resumed.destroy();
  });

  it('never creates one', async () => {
    await expect(resumeSrtNetworkSandboxSession({ sandboxId: 'none', directory })).rejects.toThrow(
      SrtSandboxNotFoundError,
    );
  });
});
