import { describe, expect, it } from 'vitest';

import { WorkspaceError } from './workspace-error.js';
import { WorkspaceLostError } from './workspace-lost-error.js';
import { WorkspaceSetupError } from './workspace-setup-error.js';

describe('workspace errors', () => {
  it('are recognised by isInstance, whichever copy of the package threw them', () => {
    const errors = [
      new WorkspaceError('failed', 'fetch', 'fatal: no'),
      new WorkspaceLostError('a'),
      new WorkspaceSetupError('pnpm install', 1, 'ERR'),
    ];

    expect(errors.map((error) => error.name)).toEqual([
      'WorkspaceError',
      'WorkspaceLostError',
      'WorkspaceSetupError',
    ]);
    expect(errors.every((error) => WorkspaceError.isInstance(error))).toBe(true);
    expect(WorkspaceLostError.isInstance(errors[1])).toBe(true);
    expect(WorkspaceSetupError.isInstance(errors[2])).toBe(true);
    expect(WorkspaceLostError.isInstance(errors[0])).toBe(false);
    expect(WorkspaceSetupError.isInstance(errors[1])).toBe(false);
    expect(WorkspaceError.isInstance(new Error('no'))).toBe(false);
    expect(WorkspaceError.isInstance(null)).toBe(false);
  });

  it('say what went wrong', () => {
    expect(new WorkspaceLostError('a')).toMatchObject({ sessionId: 'a', step: 'reattach' });
    const setup = new WorkspaceSetupError('pnpm install', 1, `${'x'.repeat(3000)}ERR_PNPM`);
    expect(setup.message).toMatch(
      /^The setup command `pnpm install` failed \(exit 1\): …x+ERR_PNPM$/,
    );
    expect(setup.message.length).toBeLessThan(2100);
    expect(setup).toMatchObject({ step: 'setup', exitCode: 1 });
  });
});
