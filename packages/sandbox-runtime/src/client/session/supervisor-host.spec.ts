import { describe, expect, it } from 'vitest';

import { SrtError } from '../errors/srt-error.js';
import { explained } from './supervisor-host.js';

describe('explained', () => {
  it('says what to do when the host restricts user namespaces', () => {
    const error = explained(
      new SrtError(
        'The sandbox stopped: apply-seccomp: write /proc/self/setgroups: Permission denied',
      ),
    );

    expect(error).toBeInstanceOf(SrtError);
    expect((error as Error).message).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
    expect((error as Error).message).toContain('allowAllUnixSockets');
  });

  it('leaves any other error as it is', () => {
    const other = new SrtError('The sandbox stopped.');
    const plain = new Error('setgroups');

    expect(explained(other)).toBe(other);
    expect(explained(plain)).toBe(plain);
  });
});
