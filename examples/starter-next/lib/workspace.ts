import type { SingleRepositoryWorkspaceSession, Workspace } from 'ai-sdk-harness-workspace';

import { createWorkspace, gitRepository, hostRepository } from 'ai-sdk-harness-workspace';
import { isAbsolute } from 'node:path';

const REPOSITORY = process.env.REPOSITORY || undefined;

function createRepositoryWorkspace(): undefined | Workspace<SingleRepositoryWorkspaceSession> {
  if (REPOSITORY === undefined) return undefined;
  return createWorkspace({
    source: isAbsolute(REPOSITORY)
      ? hostRepository({ path: REPOSITORY })
      : gitRepository({ url: REPOSITORY }),
  });
}

// Kept on globalThis so that `next dev` reloading this module keeps the checkouts it knows.
const globals = globalThis as {
  starterWorkspace?: { value: undefined | Workspace<SingleRepositoryWorkspaceSession> };
};

/**
 * The repository each conversation works on, with ai-sdk-harness-workspace: a Git checkout of its
 * own in the sandbox, whose changes the page shows as a patch. `REPOSITORY` is the path of a
 * repository on this machine, which reaches the sandbox as a Git bundle, or the https: URL of a
 * public one. Without it, the agent works in an empty directory.
 */
export const workspace = (globals.starterWorkspace ??= { value: createRepositoryWorkspace() })
  .value;
