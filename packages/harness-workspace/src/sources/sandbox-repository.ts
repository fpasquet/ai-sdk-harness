import { posix } from 'node:path';

import type { WorkspaceSource } from '../definitions/source.js';

import { fetchInto } from '../git/repository.js';
import { checkRevision, repositoryName } from '../utils/names.js';

export interface SandboxRepositoryOptions {
  /**
   * The repository in the sandbox, an absolute path: a directory of this host mounted in it (the
   * `readOnlyWorkspaces` of `ai-sdk-sandbox-sbx`), a clone its image or template holds.
   */
  path: string;
  /**
   * What a new checkout starts from: a branch, a tag or a commit of that repository.
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
 * A repository already in the sandbox: fetched from, at each new session, into the workspace's
 * own, and never written to — a read-only mount will do. No credential is involved: what the
 * sandbox holds of the repository is all it can reach.
 *
 * Keep it out of the sandbox's default working directory, where the harness makes the sessions'
 * own: an agent that climbs out of its checkout would find it.
 */
export function sandboxRepository(options: SandboxRepositoryOptions): WorkspaceSource {
  const { path } = options;
  if (!posix.isAbsolute(path)) {
    throw new TypeError(
      `\`path\` must be an absolute path in the sandbox; got ${JSON.stringify(path)}.`,
    );
  }
  const revision = checkRevision(options.ref ?? 'HEAD', '`ref`');
  return {
    name: options.name ?? repositoryName(path),
    hosts: [],
    fetch: async ({ sandbox, repository, ref, abortSignal }) => {
      await fetchInto(sandbox, {
        repository,
        from: path,
        revision,
        ref,
        // A mount belongs to another user of the sandbox: git trusts it for this fetch only.
        env: {
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'safe.directory',
          GIT_CONFIG_VALUE_0: path,
          GIT_CONFIG_KEY_1: 'safe.directory',
          GIT_CONFIG_VALUE_1: posix.join(path, '.git'),
        },
        abortSignal,
      });
    },
  };
}
