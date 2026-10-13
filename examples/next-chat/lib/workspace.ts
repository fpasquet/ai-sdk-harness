import type {
  SingleRepositoryWorkspaceSession,
  Workspace,
  WorkspaceSource,
} from 'ai-sdk-harness-workspace';

import { createWorkspace, gitRepository, hostRepository } from 'ai-sdk-harness-workspace';
import { isAbsolute } from 'node:path';

import { ExampleConfigurationError } from '@/lib/sandbox';

/**
 * The repository the conversations work on, when `EXAMPLE_REPOSITORY` names one: an `https:` URL,
 * fetched in the sandbox, or the path of a repository on this machine, sent to the sandbox as Git
 * bundles. Each conversation then works in a checkout of its own, and shows what its agent changed.
 */
export const REPOSITORY = process.env.EXAMPLE_REPOSITORY || undefined;

/** The source of {@link REPOSITORY}. */
function sourceOf(repository: string): WorkspaceSource {
  const ref = process.env.EXAMPLE_REPOSITORY_REF || undefined;
  if (isAbsolute(repository)) return hostRepository({ path: repository, ...(ref && { ref }) });
  if (!repository.startsWith('https://')) {
    throw new ExampleConfigurationError(
      `EXAMPLE_REPOSITORY must be an https: URL or the absolute path of a repository on this machine; got ${repository}.`,
    );
  }
  // A private repository's token: brokered by the sandbox, never handed to it.
  const token = process.env.EXAMPLE_REPOSITORY_TOKEN || undefined;
  return gitRepository({
    url: repository,
    ...(ref && { ref }),
    ...(token && { credentials: { token } }),
  });
}

/**
 * The workspace of {@link REPOSITORY}, or `undefined` without one. `EXAMPLE_REPOSITORY_SETUP` runs
 * in each new checkout, before the agent starts: `pnpm install`, for instance.
 */
export function createExampleWorkspace(): undefined | Workspace<SingleRepositoryWorkspaceSession> {
  if (REPOSITORY === undefined) return undefined;
  const setup = process.env.EXAMPLE_REPOSITORY_SETUP || undefined;
  return createWorkspace({ source: sourceOf(REPOSITORY), ...(setup && { setup }) });
}

/** How the page names {@link REPOSITORY}: its last segment. */
export const repositoryLabel = (): string | undefined =>
  REPOSITORY?.replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .at(-1)
    ?.replace(/\.git$/, '');
