import type { Experimental_SandboxSession as SandboxSession } from 'ai';

import type { ChangedFile, GitFileMode } from '../definitions/workspace.js';

import { checkScript, runScript, scriptError } from './sandbox-script.js';
import {
  BLOBS,
  CHANGED_FILES,
  CHANGES,
  CHECKOUT,
  FETCH,
  INIT,
  KEEP_LOCAL,
  LOCATE,
  REATTACH,
  REMOVE,
  REMOVE_DIRECTORY,
  REMOVE_FILE,
} from './scripts.js';

interface Signal {
  abortSignal?: AbortSignal | undefined;
}

const signal = ({ abortSignal }: Signal) => (abortSignal === undefined ? {} : { abortSignal });

/** The path of the workspace's repository in the sandbox: `path`, or the default one named `name`. */
export function locateRepository(
  sandbox: SandboxSession,
  { path, name, ...options }: Signal & { path: string | undefined; name: string },
): Promise<string> {
  return checkScript(sandbox, 'repository lookup', {
    script: LOCATE,
    args: [path ?? '', name],
    ...signal(options),
  });
}

/** Creates the bare repository unless it exists, with an identity for the agents' commits. */
export async function initRepository(
  sandbox: SandboxSession,
  {
    repository,
    committer,
    ...options
  }: Signal & { repository: string; committer: { name: string; email: string } },
): Promise<void> {
  await checkScript(sandbox, 'repository creation', {
    script: INIT,
    args: [repository, committer.name, committer.email],
    ...signal(options),
  });
}

/** Fetches `revision` of `from` into `ref` of the repository. */
export async function fetchInto(
  sandbox: SandboxSession,
  {
    repository,
    from,
    revision,
    ref,
    depth,
    env,
    ...options
  }: Signal & {
    repository: string;
    from: string;
    revision: string;
    ref: string;
    depth?: number | undefined;
    env?: Record<string, string>;
  },
): Promise<void> {
  await checkScript(sandbox, 'fetch', {
    script: FETCH,
    args: [repository, from, revision, ref, depth === undefined ? '' : String(depth)],
    ...(env !== undefined && { env }),
    ...signal(options),
  });
}

/** Checks out the commit at `fetched` in `directory`, on `branch`, keeping it at `base`: returns it. */
export function checkout(
  sandbox: SandboxSession,
  {
    repository,
    directory,
    branch,
    fetched,
    base,
    ...options
  }: Signal & {
    repository: string;
    directory: string;
    branch: string;
    fetched: string;
    base: string;
  },
): Promise<string> {
  return checkScript(sandbox, 'checkout', {
    script: CHECKOUT,
    args: [repository, directory, branch, fetched, base],
    ...signal(options),
  });
}

/** The base commit of the checkout in `directory`, or `undefined` when it is gone. */
export async function reattach(
  sandbox: SandboxSession,
  {
    repository,
    directory,
    base,
    ...options
  }: Signal & { repository: string; directory: string; base: string },
): Promise<string | undefined> {
  const result = await runScript(sandbox, {
    script: REATTACH,
    args: [repository, directory, base],
    ...signal(options),
  });
  if (result.exitCode === 2) return undefined;
  // Another code: not a missing checkout, the sandbox could not be asked.
  if (result.exitCode !== 0) throw scriptError('reattach', result);
  return result.stdout.trim();
}

/** What changed in the checkout since `base`, as a binary patch, its paths under `prefix`. */
export async function readChanges(
  sandbox: SandboxSession,
  {
    directory,
    base,
    prefix = '',
    ...options
  }: Signal & { directory: string; base: string; prefix?: string },
): Promise<Uint8Array> {
  const path = await checkScript(sandbox, 'changes', {
    script: CHANGES,
    args: [directory, base, prefix === '' ? '' : `${prefix}/`],
    ...signal(options),
  });
  try {
    return (await sandbox.readBinaryFile({ path, ...signal(options) })) ?? new Uint8Array();
  } finally {
    await runScript(sandbox, { script: REMOVE_FILE, args: [path] });
  }
}

/**
 * The files that changed in the checkout of `repository` since `base`, their paths under `prefix`;
 * with `contents`, what each holds.
 */
export async function listChanges(
  sandbox: SandboxSession,
  {
    directory,
    base,
    repository,
    prefix = '',
    contents = false,
    ...options
  }: Signal & {
    directory: string;
    base: string;
    repository: string;
    prefix?: string;
    contents?: boolean;
  },
): Promise<ChangedFile[]> {
  const output = await runScript(sandbox, {
    script: CHANGED_FILES,
    args: [directory, base],
    ...signal(options),
  });
  if (output.exitCode !== 0) throw scriptError('changes', output);
  const listed = parseChangedFiles(output.stdout);
  const blobs = contents
    ? await readBlobs(sandbox, {
        directory,
        ids: listed.flatMap(({ blob }) => blob ?? []),
        ...options,
      })
    : new Map<string, Uint8Array>();
  return listed.map(({ blob, ...file }) => {
    const content = blob === undefined ? undefined : blobs.get(blob);
    return {
      ...file,
      path: prefix === '' ? file.path : `${prefix}/${file.path}`,
      repository,
      ...(content !== undefined && { content }),
    };
  });
}

/** The blobs `ids` of the repository of the checkout in `directory`, read in one go. */
async function readBlobs(
  sandbox: SandboxSession,
  { directory, ids, ...options }: Signal & { directory: string; ids: string[] },
): Promise<Map<string, Uint8Array>> {
  if (ids.length === 0) return new Map();
  const path = await checkScript(sandbox, 'changes', {
    script: BLOBS,
    args: [directory, ...ids],
    ...signal(options),
  });
  try {
    const batch = (await sandbox.readBinaryFile({ path, ...signal(options) })) ?? new Uint8Array();
    return parseBlobBatch(batch);
  } finally {
    await runScript(sandbox, { script: REMOVE_FILE, args: [path] });
  }
}

const LINE_FEED = 0x0a;

/**
 * Reads `git cat-file --batch`: `<id> blob <size>\n`, the blob's bytes and a line feed, for each
 * object; `<id> missing\n` for one the repository does not have.
 */
export function parseBlobBatch(batch: Uint8Array): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < batch.length) {
    const end = batch.indexOf(LINE_FEED, offset);
    if (end === -1) break;
    const [id = '', type = '', size = ''] = decoder.decode(batch.subarray(offset, end)).split(' ');
    offset = end + 1;
    if (type === 'missing' || size === '') continue;
    const length = Number(size);
    if (type === 'blob') blobs.set(id, batch.slice(offset, offset + length));
    offset += length + 1;
  }
  return blobs;
}

/** Keeps `path` of the checkout out of its changes. */
export async function keepLocal(
  sandbox: SandboxSession,
  { directory, path, ...options }: Signal & { directory: string; path: string },
): Promise<void> {
  // An exclude pattern, anchored at the root, its glob characters taken literally.
  const pattern = `/${path.replace(/[\\*?[\]]/g, '\\$&')}`;
  await checkScript(sandbox, 'local file', {
    script: KEEP_LOCAL,
    args: [directory, path, pattern],
    ...signal(options),
  });
}

/** Removes a session's checkout, its branch and its base: the directory it removed, if any. */
export async function removeCheckout(
  sandbox: SandboxSession,
  {
    repository,
    branch,
    base,
    directory,
    ...options
  }: Signal & { repository: string; branch: string; base: string; directory?: string | undefined },
): Promise<string | undefined> {
  const removed = await checkScript(sandbox, 'removal', {
    script: REMOVE,
    args: [repository, branch, base, directory ?? ''],
    ...signal(options),
  });
  return removed === '' ? undefined : removed;
}

/** Removes the directory `path` and what it holds. */
export async function removeDirectory(
  sandbox: SandboxSession,
  { path, ...options }: Signal & { path: string },
): Promise<void> {
  await checkScript(sandbox, 'removal', {
    script: REMOVE_DIRECTORY,
    args: [path],
    ...signal(options),
  });
}

const STATUSES: Record<string, ChangedFile['status']> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'type-changed',
};

/**
 * A changed file, before it is told which repository it is in, with the blob that holds its
 * content once changed.
 */
type ListedFile = Omit<ChangedFile, 'content' | 'repository'> & { blob?: string };

const MODES: ReadonlySet<string> = new Set<GitFileMode>(['100644', '100755', '120000', '160000']);

/** Reads `git diff --raw --numstat -z`: each file's status, then its line counts. */
export function parseChangedFiles(output: string): ListedFile[] {
  const files = new Map<string, ListedFile>();
  const tokens = output.split('\0');
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    index += 1;
    if (token.startsWith(':')) {
      const path = tokens[index] ?? '';
      index += 1;
      files.set(path, statusOf(token, path));
    } else if (token !== '') {
      countLines(files, token);
    }
  }
  return [...files.values()];
}

/**
 * A file from its `--raw` entry, `:<old mode> <new mode> <old id> <new id> <status>`: its mode and
 * its blob once changed, none for a deleted file, no blob for a submodule.
 */
function statusOf(entry: string, path: string): ListedFile {
  const [, mode = '', , id = '', status = ''] = entry.slice(1).split(' ');
  const known = MODES.has(mode) ? (mode as GitFileMode) : undefined;
  return {
    path,
    status: STATUSES[status.charAt(0)] ?? 'modified',
    additions: 0,
    deletions: 0,
    binary: false,
    ...(known !== undefined && { mode: known }),
    ...(known !== undefined && known !== '160000' && { blob: id }),
  };
}

/** Adds the counts of a `--numstat` entry, `<added>\t<deleted>\t<path>`, to its file. */
function countLines(files: Map<string, ListedFile>, entry: string): void {
  const [added = '', deleted = '', ...rest] = entry.split('\t');
  const file = files.get(rest.join('\t'));
  if (file === undefined) return;
  file.binary = added === '-';
  file.additions = file.binary ? 0 : Number(added);
  file.deletions = file.binary ? 0 : Number(deleted);
}
