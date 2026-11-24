import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type { SessionFile } from '../runtimes/plugin-runtime.js';

import { homeOf, PREPARE, runScript } from './sandbox-shell.js';
import { STATE_DIR } from './sync-session-files.js';

/** What the plugins wrote under `$HOME`, so that what is no longer wanted can be taken back. */
const MANIFEST = `${STATE_DIR}/home-manifest.json`;

interface Manifest {
  version: 1;
  files: string[];
}

export interface SyncHomeFilesInput {
  session: SandboxSession;
  files: readonly SessionFile[];
  abortSignal?: AbortSignal;
}

/**
 * Writes `files` under the sandbox's `$HOME` and takes back what the plugins wrote there before
 * and `files` no longer has. Every session of the sandbox shares them: the last one to start, or to
 * resume, decides. A file the plugins did not write is never overwritten.
 */
export async function syncHomeFiles({
  session,
  files,
  abortSignal,
}: SyncHomeFilesInput): Promise<void> {
  const home = await homeOf(session, abortSignal);
  const manifestPath = posix.join(home, MANIFEST);
  const previous = await readManifest(session, manifestPath, abortSignal);
  if (files.length === 0 && previous.length === 0) return;

  const owned = new Set(previous);
  for (const { path } of files) {
    if (owned.has(path)) continue;
    if ((await session.readTextFile({ path: posix.join(home, path), abortSignal })) !== null) {
      throw new Error(
        `$HOME/${path} is already in the sandbox, and the plugins did not write it: they leave it alone. Rename what they would write there, or remove the file.`,
      );
    }
  }
  const wanted = new Set(files.map(({ path }) => path));
  const stale = previous.filter((path) => !wanted.has(path));
  const directories = [STATE_DIR, ...new Set(files.map(({ path }) => posix.dirname(path)))];
  await runScript(
    session,
    { script: PREPARE, args: [...stale, '--', ...directories], directory: home },
    abortSignal,
  );
  for (const { path, content } of files) {
    await session.writeTextFile({ path: posix.join(home, path), content, abortSignal });
  }
  const manifest: Manifest = { version: 1, files: [...wanted] };
  await session.writeTextFile({
    path: manifestPath,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    abortSignal,
  });
}

async function readManifest(
  session: SandboxSession,
  path: string,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const text = await session.readTextFile({ path, abortSignal });
  if (text === null) return [];
  try {
    const manifest = JSON.parse(text) as Partial<Manifest>;
    return manifest.version === 1 && Array.isArray(manifest.files)
      ? manifest.files.filter((path): path is string => typeof path === 'string')
      : [];
  } catch {
    return [];
  }
}
