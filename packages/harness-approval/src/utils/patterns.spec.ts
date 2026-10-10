import { describe, expect, it } from 'vitest';

import { matchesCommand, matchesPath } from './patterns.js';
import { commandOf, normalizePath, pathsOf, toolKindOf } from './requests.js';

describe('matchesCommand', () => {
  it('matches a command starting with the pattern, word by word', () => {
    expect(matchesCommand('git push', 'git push')).toBe(true);
    expect(matchesCommand('git push', 'git push origin main')).toBe(true);
    expect(matchesCommand('git  push ', 'git push --force')).toBe(true);
    expect(matchesCommand('git push', 'git pushy')).toBe(false);
    expect(matchesCommand('git push', 'git status')).toBe(false);
    expect(matchesCommand('push', 'git push')).toBe(false);
  });

  it('takes * for anything, and the rest literally', () => {
    expect(matchesCommand('npm run test:*', 'npm run test:unit')).toBe(true);
    expect(matchesCommand('npm run test:*', 'npm run build')).toBe(false);
    expect(matchesCommand('* --version', 'node --version')).toBe(true);
    expect(matchesCommand('node a.js', 'node aXjs')).toBe(false);
    expect(matchesCommand('   ', 'ls')).toBe(false);
  });
});

describe('matchesPath', () => {
  it('matches a file name in any directory when the glob has no slash', () => {
    expect(matchesPath('.env*', '/home/agent/work/.env')).toBe(true);
    expect(matchesPath('.env*', 'config/.env.local')).toBe(true);
    expect(matchesPath('.env*', '/home/agent/.envoy/config')).toBe(false);
    expect(matchesPath('*.lock', 'pnpm-lock.yaml')).toBe(false);
    expect(matchesPath('?.ts', 'src/a.ts')).toBe(true);
  });

  it('matches the end of the path when the glob has one', () => {
    expect(matchesPath('src/**', '/home/agent/claude-code-1/src/app/page.tsx')).toBe(true);
    expect(matchesPath('src/*', '/home/agent/claude-code-1/src/app/page.tsx')).toBe(false);
    expect(matchesPath('src/', 'src/index.ts')).toBe(true);
    expect(matchesPath('./docs/**/*.md', 'docs/guide.md')).toBe(true);
    expect(matchesPath('docs/**/*.md', 'docs/a/b/guide.md')).toBe(true);
    expect(matchesPath('src/**', 'mysrc/index.ts')).toBe(false);
  });

  it('anchors a glob starting with a slash at the root', () => {
    expect(matchesPath('/etc/**', '/etc/passwd')).toBe(true);
    expect(matchesPath('/etc/**', '/home/etc/passwd')).toBe(false);
  });
});

describe('requests', () => {
  it('tells the kind of a tool by its name', () => {
    expect(toolKindOf('bash')).toBe('command');
    expect(toolKindOf('Write')).toBe('edit');
    expect(toolKindOf('TodoWrite')).toBe('bookkeeping');
    expect(toolKindOf('webSearch')).toBe('other');
  });

  it('reads the command of a tool, parsed or as JSON', () => {
    expect(commandOf('bash', { command: 'ls' })).toBe('ls');
    expect(commandOf('bash', '{"command":"pwd"}')).toBe('pwd');
    expect(commandOf('bash', { command: ['git', 'status'] })).toBe('git status');
    expect(commandOf('bash', 'not json')).toBeUndefined();
    expect(commandOf('bash', { command: 3 })).toBeUndefined();
    expect(commandOf('bash', null)).toBeUndefined();
  });

  it('reads the files an edit writes, without . and ..', () => {
    expect(pathsOf({ file_path: '/w/src/../.env', content: '' })).toEqual(['/w/.env']);
    expect(pathsOf({ notebook_path: './a/./b.ipynb' })).toEqual(['a/b.ipynb']);
    expect(pathsOf({ file_path: '' })).toEqual([]);
    expect(normalizePath('../../x')).toBe('x');
  });
});
