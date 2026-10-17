import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import { describe, expect, it } from 'vitest';

import type { Workspace } from '../definitions/workspace.js';

import { withWorkspace } from './with-workspace.js';

/** A workspace whose `onSession` only says it ran. */
function recordingWorkspace(events: string[]): Workspace {
  return {
    onSession: () => {
      events.push('workspace');
      return Promise.resolve();
    },
  } as unknown as Workspace;
}

const harness = { harnessId: 'claude-code' };
const input = { session: {} as SandboxSession, sessionWorkDir: '/work/claude-code-a' };

describe('withWorkspace', () => {
  it('checks the workspace out before your own onSession, and keeps the rest of the settings', async () => {
    const events: string[] = [];
    const settings = withWorkspace(
      {
        harness,
        model: 'claude',
        sandboxConfig: {
          workDir: 'w',
          onSession: () => {
            events.push('own');
            return Promise.resolve();
          },
        },
      },
      recordingWorkspace(events),
    );

    await settings.sandboxConfig.onSession!(input);

    expect(events).toEqual(['workspace', 'own']);
    expect(settings).toMatchObject({ model: 'claude', sandboxConfig: { workDir: 'w' } });
  });

  it('takes the deprecated onSandboxSession in place of sandboxConfig.onSession', async () => {
    const events: string[] = [];
    const settings = withWorkspace(
      {
        harness,
        onSandboxSession: () => {
          events.push('own');
          return Promise.resolve();
        },
      },
      recordingWorkspace(events),
    );

    await settings.sandboxConfig.onSession!(input);

    expect(events).toEqual(['workspace', 'own']);
    expect('onSandboxSession' in settings).toBe(false);
  });
});
