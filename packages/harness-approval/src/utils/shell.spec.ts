import { describe, expect, it } from 'vitest';

import { commandSegments, normalizeWords } from './shell.js';

const commands = (script: string) => commandSegments(script).map(({ command }) => command);

describe('commandSegments', () => {
  it('reads a simple command, its words one space apart', () => {
    expect(commandSegments('git   status  --short')).toEqual([
      { command: 'git status --short', writes: false, files: [] },
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
    expect(commandSegments('echo hi > notes.txt')).toEqual([
      { command: 'echo hi', writes: true, files: ['notes.txt'] },
    ]);
    expect(commandSegments('echo hi >> "notes.txt"')[0]?.files).toEqual(['notes.txt']);
    expect(commandSegments('echo hi > "my notes.txt"')[0]?.files).toEqual(['my notes.txt']);
    expect(commandSegments('make &> build.log')[0]?.writes).toBe(true);
    expect(commandSegments('cat a >| b')[0]?.writes).toBe(true);
  });

  it('does not take descriptors and /dev/null for files', () => {
    expect(commandSegments('pnpm test 2>&1 | tail -5')).toEqual([
      { command: 'pnpm test', writes: false, files: [] },
      { command: 'tail -5', writes: false, files: [] },
    ]);
    expect(commandSegments('ls missing 2> /dev/null')).toEqual([
      { command: 'ls missing', writes: false, files: [] },
    ]);
    expect(commandSegments('echo oops >&2')[0]?.writes).toBe(false);
    expect(commandSegments('exec 3>&-')[0]?.writes).toBe(false);
  });

  it('never reads the body of a here-document as commands or redirections', () => {
    const script = [
      "cd apps && python3 - <<'E'",
      'import re',
      'rooms = db.query("select * from rooms where capacity >= $1 and equipment @> $2")',
      "print('done') && rm -rf / > x",
      'E',
      'ls',
    ].join('\n');
    expect(commandSegments(script)).toEqual([
      { command: 'cd apps', writes: false, files: [] },
      { command: 'python3 -', writes: false, files: [] },
      { command: 'ls', writes: false, files: [] },
    ]);
    expect(commands('cat <<EOF\nrm -rf / > x\nEOF')).toEqual(['cat']);
    expect(commands('cat <<"EOF"\nrm -rf / > x\nEOF\nls')).toEqual(['cat', 'ls']);
    expect(commands('cat<<EOF | grep a\na > x\nEOF')).toEqual(['cat', 'grep a']);
    // `<<-` strips the tabs before the delimiter, which then closes the body.
    expect(commands('cat <<-EOF\n\trm -rf /\n\tEOF\nls')).toEqual(['cat', 'ls']);
    // Several here-documents on one line: their bodies follow it, one after the other.
    expect(commands('cat <<A; cat <<B\na > x\nA\nb > y\nB\nls')).toEqual(['cat', 'cat', 'ls']);
    // A here-string is a word, not a here-document.
    expect(commands('cat <<< hi\nls')).toEqual(['cat <<< hi', 'ls']);
  });

  it('still counts the substitutions of a here-document whose delimiter is not quoted', () => {
    expect(commands('cat <<EOF\nnow: $(date) `whoami` $1 \\$(id) $((1 + 2))\nEOF')).toEqual([
      'cat',
      'date',
      'whoami',
    ]);
    expect(commands("cat <<'EOF'\nnow: $(date) `whoami`\nEOF")).toEqual(['cat']);
  });

  it('sees the redirections on the line of a here-document', () => {
    expect(commandSegments("cat > apps/e2e/package.json <<'EOF'\n{}\nEOF")).toEqual([
      { command: 'cat', writes: true, files: ['apps/e2e/package.json'] },
    ]);
    expect(commandSegments("cat <<'EOF' > notes.txt\nhi\nEOF\nls")).toEqual([
      { command: 'cat', writes: true, files: ['notes.txt'] },
      { command: 'ls', writes: false, files: [] },
    ]);
    expect(commandSegments('cat <<EOF 2>/dev/null\nhi\nEOF')).toEqual([
      { command: 'cat', writes: false, files: [] },
    ]);
  });

  it('reads a script past what only looks like a here-document', () => {
    expect(commands('ls # <<EOF\nrm -rf /')).toEqual(['ls', 'rm -rf /']);
    expect(commands('ls\n((1<<2))\nrm -rf /')).toEqual(['ls', 'rm -rf /']);
    expect(commands('echo ${x:-<<EOF}\nrm -rf /')).toContain('rm -rf /');
    expect(commands('echo $[1<<2]\nrm -rf /')).toContain('rm -rf /');
  });

  it('never skips a body whose end it cannot read', () => {
    const opaque = (script: string) => commandSegments(script).some((part) => part.opaque);
    expect(opaque('cat <<EOF\nnever closed > x')).toBe(true);
    expect(opaque("cat <<$'EOF'\nhi\nEOF\nrm -rf /")).toBe(true);
    expect(commands("cat <<$'EOF'\nhi\nEOF\nrm -rf /")).toContain('rm -rf /');
    expect(commands('cat <<EOF$(true)\nEOF$(true)\nrm -rf /')).toContain('rm -rf /');
    expect(opaque('cat <<EOF\nEO\\\nF\nrm -rf /')).toBe(true);
  });

  it('keeps every command of a quoted redirection target', () => {
    expect(commands('ls > "a\\"" ; rm -rf / ; echo "b"')).toEqual(['ls', 'rm -rf /', 'echo b']);
    expect(commands('ls > "$(rm -rf /)"')).toEqual(['ls', 'rm -rf /']);
  });

  it('keeps a redirection with no command, and takes `>&file` for a file', () => {
    expect(commandSegments('ls; > .env')[1]).toEqual({
      command: '',
      writes: true,
      files: ['.env'],
    });
    expect(commandSegments('{ ls; } > .env')[1]?.files).toEqual(['.env']);
    expect(commandSegments('(ls) > .env')[1]?.files).toEqual(['.env']);
    expect(commandSegments('ls >&.env')[0]?.files).toEqual(['.env']);
    expect(commandSegments('ls >& .env')[0]?.files).toEqual(['.env']);
  });

  it('finds the substitutions arithmetic, parentheses or quotes hide', () => {
    expect(commands('echo $(( $(rm -rf /) + 1 ))')).toEqual(['echo', 'rm -rf /']);
    expect(commands('echo $((rm -rf /) ; true)')).toContain('rm -rf /');
    expect(commands('echo $(echo ")"; rm -rf /)')).toEqual(['echo', 'echo )', 'rm -rf /']);
    expect(commands('cat <<EOF\n$(( $(rm -rf /) + 1 ))\nEOF')).toEqual(['cat', 'rm -rf /']);
    expect(commands('cat <<EOF\n$(echo ")"; rm -rf /)\nEOF')).toContain('rm -rf /');
  });

  it('marks a command whose name the shell only knows as it runs', () => {
    const script = (text: string) => commandSegments(text).find((part) => part.opaque)?.command;
    expect(script('$(echo rm -rf /)')).toBe('$(echo rm -rf /)');
    expect(script('`echo rm -rf /`')).toBe('`echo rm -rf /`');
    expect(script('ls && rm${IFS}-rf${IFS}/')).toBe('rm${IFS}-rf${IFS}/');
    expect(script('"$TOOL" run')).toBe('"$TOOL" run');
    // Its arguments may expand, and an assignment is not a name.
    expect(script('echo $HOME "$(date)"')).toBeUndefined();
    expect(script('OUT=$(date) ls')).toBeUndefined();
  });

  it('reads ANSI-C quotes as one word, and drops comments and joined lines', () => {
    expect(commands("echo $'\\'' ; rm -rf / ; echo ''")).toEqual([
      String.raw`echo \'`,
      'rm -rf /',
      'echo',
    ]);
    expect(commands('ls # all of it\ngit status')).toEqual(['ls', 'git status']);
    expect(commands('echo a#b')).toEqual(['echo a#b']);
    expect(commands('rm \\\n-rf /')).toEqual(['rm -rf /']);
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
