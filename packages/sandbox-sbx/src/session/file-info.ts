/** Information about a path, symbolic links followed: what `stat` of a session resolves to. */
export interface FileStat {
  type: 'directory' | 'file' | 'other';
  /** Size in bytes; for a directory, what the sandbox's filesystem says. */
  size: number;
}

/** One entry of a directory: what `listDirectory` of a session resolves to. */
export interface DirectoryEntry {
  name: string;
  /** A symbolic link is reported as such, not followed. */
  type: 'directory' | 'file' | 'other' | 'symlink';
}

/** The output of the `STAT` script, `<type> <size>`, as a {@link FileStat}. */
export function parseStat(stdout: Uint8Array): FileStat {
  const [type = 'other', size = '0'] = Buffer.from(stdout).toString().trim().split(/\s+/);
  return { type: type as FileStat['type'], size: Number(size) || 0 };
}

/** The output of the `LIST` script, `<type> <name>` records each ended by a NUL, as entries. */
export function parseEntries(stdout: Uint8Array): DirectoryEntry[] {
  return Buffer.from(stdout)
    .toString()
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const space = record.indexOf(' ');
      return {
        type: record.slice(0, space) as DirectoryEntry['type'],
        name: record.slice(space + 1),
      };
    });
}

const MESSAGES = { EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory' };

/** The error Node.js's `fs` throws for `code`, on the operation `syscall` of `path`. */
export function fileError(code: keyof typeof MESSAGES, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${MESSAGES[code]}, ${syscall} '${path}'`), { code });
}
