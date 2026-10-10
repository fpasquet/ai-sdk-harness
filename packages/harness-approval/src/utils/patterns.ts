const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `command` starts with `pattern`, word by word: `git push` matches `git push origin`,
 * not `git pushy`. `*` matches anything, spaces included: `npm run test:*`.
 */
export function matchesCommand(pattern: string, command: string): boolean {
  const words = pattern.trim().split(/\s+/).join(' ');
  if (words === '') return false;
  const source = escape(words).replaceAll('*', '.*');
  return new RegExp(`^${source}(?: .*)?$`).test(command);
}

/** A path glob as a regular expression: `**` crosses directories, `*` and `?` do not. */
function globSource(glob: string): string {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escape(char);
  }
  return source;
}

/**
 * Whether `path` matches the glob `pattern`, as `.gitignore` reads it: a pattern without a slash,
 * `.env*`, matches a file name in any directory; one with a slash, `src/**`, matches the end of
 * the path, whatever directory the session works in.
 */
export function matchesPath(pattern: string, path: string): boolean {
  const glob = pattern.replace(/^\.\//, '').replace(/\/$/, '/**');
  const anchored = glob.startsWith('/');
  const source = globSource(anchored ? glob.slice(1) : glob);
  const prefix = anchored ? '^/' : glob.includes('/') ? '(?:^|/)' : '(?:^|/)(?=[^/]*$)';
  return new RegExp(`${prefix}${source}$`).test(path);
}
