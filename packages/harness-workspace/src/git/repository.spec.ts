import { describe, expect, it } from 'vitest';

import { parseChangedFiles } from './repository.js';

describe('parseChangedFiles', () => {
  it('reads the statuses, then the line counts, of `git diff --raw --numstat -z`', () => {
    const raw = [
      ':100644 100644 789819 204dd9 M',
      'a',
      ':100644 100644 bdc955 25cb95 M',
      'b.bin',
      ':100644 000000 f2ad6c 000000 D',
      'c',
      ':000000 100644 000000 8ba3a1 A',
      'new\tfile',
      ':100644 120000 aaaaaa bbbbbb T',
      'link',
      '1\t0\ta',
      '-\t-\tb.bin',
      '0\t1\tc',
      '1\t0\tnew\tfile',
      '1\t1\tlink',
      '',
    ].join('\0');

    expect(parseChangedFiles(raw)).toEqual([
      { path: 'a', status: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'b.bin', status: 'modified', additions: 0, deletions: 0, binary: true },
      { path: 'c', status: 'deleted', additions: 0, deletions: 1, binary: false },
      { path: 'new\tfile', status: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'link', status: 'type-changed', additions: 1, deletions: 1, binary: false },
    ]);
    expect(parseChangedFiles('')).toEqual([]);
  });
});
