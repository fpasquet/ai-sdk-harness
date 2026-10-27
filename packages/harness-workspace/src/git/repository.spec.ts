import { describe, expect, it } from 'vitest';

import { parseBlobBatch, parseChangedFiles } from './repository.js';

const counts = (additions: number, deletions: number, binary = false) => ({
  additions,
  deletions,
  binary,
});

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
      ':160000 160000 cccccc dddddd M',
      'lib',
      '1\t0\ta',
      '-\t-\tb.bin',
      '0\t1\tc',
      '1\t0\tnew\tfile',
      '1\t1\tlink',
      '1\t1\tlib',
      '',
    ].join('\0');

    expect(parseChangedFiles(raw)).toEqual([
      { ...counts(1, 0), path: 'a', status: 'modified', mode: '100644', blob: '204dd9' },
      { ...counts(0, 0, true), path: 'b.bin', status: 'modified', mode: '100644', blob: '25cb95' },
      { ...counts(0, 1), path: 'c', status: 'deleted' },
      { ...counts(1, 0), path: 'new\tfile', status: 'added', mode: '100644', blob: '8ba3a1' },
      { ...counts(1, 1), path: 'link', status: 'type-changed', mode: '120000', blob: 'bbbbbb' },
      { ...counts(1, 1), path: 'lib', status: 'modified', mode: '160000' },
    ]);
    expect(parseChangedFiles('')).toEqual([]);
  });
});

describe('parseBlobBatch', () => {
  it('reads each blob of `git cat-file --batch`, line feeds and all, and skips a missing one', () => {
    const encoder = new TextEncoder();
    const batch = new Uint8Array([
      ...encoder.encode('aaa blob 3\n'),
      ...[10, 0, 10],
      10,
      ...encoder.encode('bbb missing\n'),
      ...encoder.encode('ccc blob 0\n'),
      10,
    ]);

    const blobs = parseBlobBatch(batch);

    expect([...(blobs.get('aaa') ?? [])]).toEqual([10, 0, 10]);
    expect(blobs.has('bbb')).toBe(false);
    expect(blobs.get('ccc')).toEqual(new Uint8Array());
  });
});
