import { describe, expect, it } from 'vitest';

import { checkRelativePath, isRevision, repositoryName, sessionKey } from './names.js';

describe('names', () => {
  it('keeps a session id that fits in a ref, and hashes the others', () => {
    expect(sessionKey('0f8c2a1e-7d4b-4c11-9a2e-5b6d7e8f9a0b')).toBe(
      '0f8c2a1e-7d4b-4c11-9a2e-5b6d7e8f9a0b',
    );
    expect(sessionKey('a user/session')).toMatch(/^[0-9a-f]{32}$/);
    expect(sessionKey('-leading')).toMatch(/^[0-9a-f]{32}$/);
    expect(sessionKey('a user/session')).toBe(sessionKey('a user/session'));
  });

  it('takes branches, tags, HEAD and commits as revisions, and nothing that reads as an option or a range', () => {
    for (const ref of ['HEAD', 'main', 'release/1.2', 'v1.0.0', 'a'.repeat(40)]) {
      expect(isRevision(ref)).toBe(true);
    }
    for (const ref of [
      '',
      '-x',
      '--upload-pack=x',
      'a..b',
      'a b',
      'a/',
      'a//b',
      'x.lock',
      'a~1',
      'a^',
      'a:b',
      'a.',
    ]) {
      expect(isRevision(ref)).toBe(false);
    }
  });

  it('takes a path relative to the checkout, outside .git', () => {
    expect(checkRelativePath('a/./b')).toBe('a/b');
    expect(checkRelativePath('.env.local')).toBe('.env.local');
    for (const path of ['', '.', '/etc/passwd', '../x', 'a/../../x', '.git/config', 'a/.git/x']) {
      expect(() => checkRelativePath(path)).toThrow(TypeError);
    }
  });

  it('names a repository after its URL or its path', () => {
    expect(repositoryName('/acme/widgets.git')).toBe('widgets');
    expect(repositoryName('/home/me/code/my app/')).toBe('my-app');
    expect(repositoryName('/')).toBe('repository');
  });
});
