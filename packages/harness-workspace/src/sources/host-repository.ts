import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { Readable } from 'node:stream';

import type { WorkspaceSource } from '../definitions/source.js';

import { fetchInto } from '../git/repository.js';
import { checkScript, runScript } from '../git/sandbox-script.js';
import { HAS_COMMIT, REMOVE_FILE } from '../git/scripts.js';
import { hostGit } from '../host/host-git.js';
import { checkRevision, repositoryName } from '../utils/names.js';

export interface HostRepositoryOptions {
  /** The repository on this host: its working tree, or a bare repository. An absolute path. */
  path: string;
  /**
   * What a new checkout starts from: a branch or a tag of that repository — not a commit, which
   * a Git bundle cannot carry by itself.
   *
   * @defaultValue `'HEAD'`, what it has checked out
   */
  ref?: string;
  /**
   * The name of the workspace's repository in the sandbox.
   *
   * @defaultValue the last segment of `path`
   */
  name?: string;
}

/**
 * A repository on this host, sent to the sandbox as a Git bundle at each new session: only the
 * commits the sandbox does not have yet. Nothing in the sandbox can reach the repository, nor the
 * server it comes from: keep it up to date on this host — a `git fetch` with your own
 * credentials — and the sandboxes get it without any. Needs `git` on this host.
 */
export function hostRepository(options: HostRepositoryOptions): WorkspaceSource {
  const { path } = options;
  if (!isAbsolute(path)) {
    throw new TypeError(
      `\`path\` must be an absolute path on this host; got ${JSON.stringify(path)}.`,
    );
  }
  const revision = checkRevision(options.ref ?? 'HEAD', '`ref`');
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(revision)) {
    throw new TypeError(
      '`ref` must be a branch or a tag: a Git bundle cannot carry a commit by itself.',
    );
  }
  return {
    name: options.name ?? repositoryName(path),
    // The bundles are written into the sandbox: it reaches no host for them.
    hosts: [],
    fetch: async ({ sandbox, repository, ref, abortSignal }) => {
      const commit = await hostGit(
        path,
        ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
        { step: 'fetch' },
      );
      const answer = await checkScript(sandbox, 'fetch', {
        script: HAS_COMMIT,
        args: [repository, commit, ref],
        ...(abortSignal !== undefined && { abortSignal }),
      });
      if (answer === 'present') return;

      // The commits the sandbox has and this host knows: the bundle leaves them out.
      const held = answer.split('\n').filter((line) => /^[0-9a-f]{40,64}$/.test(line));
      const known = await knownCommits(path, held);
      const directory = await mkdtemp(join(tmpdir(), 'ai-sdk-harness-workspace-'));
      const bundle = join(directory, 'source.bundle');
      const remote = posix.join(repository, `ai-sdk-harness-${randomUUID()}.bundle`);
      try {
        await hostGit(path, ['bundle', 'create', '--quiet', bundle, '--stdin'], {
          input: [revision, ...known.map((sha) => `^${sha}`)].join('\n') + '\n',
          step: 'fetch',
        });
        await sandbox.writeFile({
          path: remote,
          content: Readable.toWeb(createReadStream(bundle)) as ReadableStream<Uint8Array>,
          ...(abortSignal !== undefined && { abortSignal }),
        });
        await fetchInto(sandbox, { repository, from: remote, revision, ref, abortSignal });
      } finally {
        await rm(directory, { recursive: true, force: true });
        await runScript(sandbox, { script: REMOVE_FILE, args: [remote] }).catch(() => undefined);
      }
    },
  };
}

/** The commits among `shas` the repository at `path` has. */
async function knownCommits(path: string, shas: readonly string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const output = await hostGit(path, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: shas.join('\n') + '\n',
    step: 'fetch',
  });
  return output
    .split('\n')
    .map((line) => line.split(' '))
    .flatMap(([sha, type]) => (sha !== undefined && type === 'commit' ? [sha] : []));
}
