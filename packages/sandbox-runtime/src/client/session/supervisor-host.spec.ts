import { describe, expect, it } from 'vitest';

import { SrtError } from '../errors/srt-error.js';
import { explained } from './supervisor-host.js';

describe('explained', () => {
  it('says what to do when the host restricts user namespaces', () => {
    const error = explained(
      new SrtError(
        'The sandbox stopped: apply-seccomp: write /proc/self/setgroups: Permission denied',
      ),
      false,
    );

    expect(error).toBeInstanceOf(SrtError);
    expect((error as Error).message).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
    expect((error as Error).message).toContain('allowAllUnixSockets');
  });

  it('says that only running without the filter helps where AppArmor confines bwrap', () => {
    const error = explained(new SrtError('apply-seccomp: write /proc/self/setgroups'), true);

    expect((error as Error).message).toContain('unpriv_bwrap denies every capability');
    expect((error as Error).message).toContain('allowAllUnixSockets: true');
    expect((error as Error).message).not.toContain('sysctl');
  });

  it('leaves any other error as it is', () => {
    const other = new SrtError('The sandbox stopped.');
    const plain = new Error('setgroups');

    expect(explained(other)).toBe(other);
    expect(explained(plain)).toBe(plain);
  });
});
