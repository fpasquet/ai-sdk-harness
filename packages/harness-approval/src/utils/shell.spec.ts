import { describe, expect, it } from 'vitest';

import { commandSegments, normalizeWords } from './shell.js';

const commands = (script: string) => commandSegments(script).map(({ command }) => command);

describe('commandSegments', () => {
  it('reads a simple command, its words one space apart', () => {
    expect(commandSegments('git   status  --short')).toEqual([
      { command: 'git status --short', writes: false },
    ]);
  });

  it('splits commands chained, piped or put in the background', () => {
    expect(commands('cd app && pnpm test || echo failed; ls | wc -l & sleep 1')).toEqual([
      'cd app',
      'pnpm test',
      'echo failed',
      'ls',
      'wc -l',
      'sleep 1',
    ]);
    expect(commands('make build\nrm -rf dist')).toEqual(['make build', 'rm -rf dist']);
    expect(commands('(cd app; rm -rf node_modules)')).toEqual(['cd app', 'rm -rf node_modules']);
  });

  it('keeps quoted separators in their word', () => {
    expect(commands(`git commit -m "fix: a && b; c" && echo 'x | y'`)).toEqual([
      'git commit -m fix: a && b; c',
      'echo x | y',
    ]);
    expect(commands('echo a\\;b')).toEqual(['echo a;b']);
  });

  it('counts command substitutions as commands of their own, quoted or not', () => {
    expect(commands('echo $(rm -rf /) done')).toEqual(['echo done', 'rm -rf /']);
    expect(commands('echo "today: $(date)" `whoami`')).toEqual(['echo today: ', 'date', 'whoami']);
    expect(commands('diff <(ls a) >(cat)')).toEqual(['diff', 'ls a', 'cat']);
    expect(commands('echo "`id`"')).toEqual(['echo', 'id']);
    // Arithmetic, not a command.
    expect(commands('echo answer-$((40 + 2)) "$(( 1 + (2 * 3) ))"')).toEqual(['echo answer-']);
  });

  it('drops variable assignments, keywords and the path of the command', () => {
    expect(commands('NODE_ENV=test FOO="a b" /usr/bin/node app.js')).toEqual(['node app.js']);
    expect(commands('if true; then \\rm -f x; fi')).toEqual(['true', 'rm -f x']);
    expect(commands('! grep -q x file')).toEqual(['grep -q x file']);
    expect(commands('for f in *; do echo $f; done')).toEqual(['for f in *', 'echo $f']);
  });

  it('tells a command that writes to a file through a redirection', () => {
    expect(commandSegments('echo hi > notes.txt')).toEqual([{ command: 'echo hi', writes: true }]);
    expect(commandSegments('echo hi >> "notes.txt"')[0]?.writes).toBe(true);
    expect(commandSegments('make &> build.log')[0]?.writes).toBe(true);
    expect(commandSegments('cat a >| b')[0]?.writes).toBe(true);
  });

  it('does not take descriptors and /dev/null for files', () => {
    expect(commandSegments('pnpm test 2>&1 | tail -5')).toEqual([
      { command: 'pnpm test', writes: false },
      { command: 'tail -5', writes: false },
    ]);
    expect(commandSegments('ls missing 2> /dev/null')).toEqual([
      { command: 'ls missing', writes: false },
    ]);
    expect(commandSegments('echo oops >&2')[0]?.writes).toBe(false);
    expect(commandSegments('exec 3>&-')[0]?.writes).toBe(false);
  });

  it('reads nothing in an empty script, and survives unclosed quotes', () => {
    expect(commandSegments('  ')).toEqual([]);
    expect(commands(`echo 'never closed`)).toEqual(['echo never closed']);
    expect(commands('echo "never closed')).toEqual(['echo never closed']);
    expect(commands('echo $(never closed')).toEqual(['echo', 'never closed']);
    expect(commands('echo `never closed')).toEqual(['echo', 'never closed']);
  });
});

describe('normalizeWords', () => {
  it('names the command by its file name', () => {
    expect(normalizeWords(['./scripts/deploy.sh', '--prod'])).toBe('deploy.sh --prod');
    expect(normalizeWords(['A=1', 'time'])).toBe('');
  });
});
