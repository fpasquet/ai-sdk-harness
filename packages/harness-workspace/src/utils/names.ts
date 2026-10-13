import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** A session id as it is, when it fits in a Git ref and a file name; hashed otherwise. */
export function sessionKey(sessionId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sessionId)
    ? sessionId
    : createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

/** The ref that keeps the commit a session's checkout started from. */
export const baseRef = (key: string): string => `refs/ai-sdk-harness/base/${key}`;

/** Where a source leaves the commit a new checkout starts from. */
export const fetchedRef = (key: string): string => `refs/ai-sdk-harness/fetched/${key}`;

/**
 * Whether `ref` can be handed to git as a revision: a branch, a tag, `HEAD` or a commit. Stricter
 * than git itself, so that nothing in it can read as an option or a range.
 */
export function isRevision(ref: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.lock') &&
    !ref.endsWith('.')
  );
}

/** Throws a `TypeError` naming `what` unless {@link isRevision}. */
export function checkRevision(ref: string, what: string): string {
  if (!isRevision(ref)) {
    throw new TypeError(
      `${what} must be a branch, a tag, HEAD or a commit; got ${JSON.stringify(ref)}.`,
    );
  }
  return ref;
}

/**
 * `path` as a path relative to a checkout, normalized, or a `TypeError`: absolute, out of the
 * checkout, or into its `.git`.
 */
export function checkRelativePath(path: string): string {
  const normalized = posix.normalize(path);
  if (
    path === '' ||
    posix.isAbsolute(normalized) ||
    normalized === '.' ||
    normalized.split('/').some((part) => part === '..' || part === '.git')
  ) {
    throw new TypeError(
      `A path in the checkout must be relative to it, outside .git; got ${JSON.stringify(path)}.`,
    );
  }
  return normalized.replace(/\/$/, '');
}

/** A name for the repository of a source, from its URL or its path: `acme/widgets.git` → `widgets`. */
export function repositoryName(location: string): string {
  const last =
    location
      .replace(/[/\\]+$/, '')
      .split(/[/\\:]/)
      .at(-1) ?? '';
  const name = last
    .replace(/\.git$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '');
  return name === '' ? 'repository' : name;
}
