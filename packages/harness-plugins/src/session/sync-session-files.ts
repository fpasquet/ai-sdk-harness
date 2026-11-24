import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type { SessionFile, SessionLayout } from '../runtimes/plugin-runtime.js';

import { CLAUDE_LOCAL_SETTINGS } from '../runtimes/claude-code.js';
import { mergeHookGroups, parseSettings } from './local-settings.js';
import { FINISH, PREPARE, runScript } from './sandbox-shell.js';

/** The directory of the session this package owns: the plugins' files and its manifest. */
export const STATE_DIR = '.ai-sdk-harness';
const MANIFEST = `${STATE_DIR}/manifest.json`;
/** Git ignores the state directory on its own, whatever the repository. */
const SELF_IGNORE: SessionFile = { path: `${STATE_DIR}/.gitignore`, content: '*\n' };

/** What was written the previous time, so that what is no longer wanted can be taken back. */
interface Manifest {
  version: 1;
  files: string[];
  /** The hook groups an earlier version wrote in `.claude/settings.local.json`, to take back. */
  hookGroups: string[];
  /** Whether `.claude/settings.local.json` did not exist before the plugins wrote it. */
  createdSettings: boolean;
}

const EMPTY: Manifest = { version: 1, files: [], hookGroups: [], createdSettings: false };

export interface SyncSessionFilesInput {
  session: SandboxSession;
  sessionWorkDir: string;
  layout: SessionLayout;
  abortSignal?: AbortSignal;
}

/**
 * Writes the files of `layout` in the session's working directory and takes back what the previous
 * call wrote and `layout` no longer has — a plugin turned off between a session and its resume —,
 * the hooks an earlier version wrote in `.claude/settings.local.json` included. The files are kept
 * out of Git: the state directory ignores itself, the others go to `info/exclude`.
 */
export async function syncSessionFiles(input: SyncSessionFilesInput): Promise<void> {
  const { session, sessionWorkDir: directory, layout, abortSignal } = input;
  const previous = await readManifest(input);
  const files = [...layout.files, SELF_IGNORE];
  const wanted = new Set(files.map(({ path }) => path));
  const stale = previous.files.filter((path) => !wanted.has(path));
  const directories = [...new Set(files.map(({ path }) => posix.dirname(path)))];

  await runScript(
    session,
    { script: PREPARE, args: [...stale, '--', ...directories], directory },
    abortSignal,
  );
  for (const { path, content } of files) {
    await session.writeTextFile({ path: posix.join(directory, path), content, abortSignal });
  }
  await takeBackSettings(input, previous);
  const executables = files.filter(({ executable }) => executable === true).map(({ path }) => path);
  const excluded = layout.files.map(({ path }) => path);
  await runScript(
    session,
    { script: FINISH, args: [...executables, '--', ...excluded], directory },
    abortSignal,
  );

  const manifest: Manifest = {
    version: 1,
    files: layout.files.map(({ path }) => path),
    hookGroups: [],
    createdSettings: false,
  };
  await session.writeTextFile({
    path: posix.join(directory, MANIFEST),
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    abortSignal,
  });
}

/**
 * Takes the hook groups an earlier version wrote out of `.claude/settings.local.json`, and removes
 * the file once nothing else is left in it.
 */
async function takeBackSettings(
  { session, sessionWorkDir, abortSignal }: SyncSessionFilesInput,
  previous: Manifest,
): Promise<void> {
  if (previous.hookGroups.length === 0) return;
  const path = posix.join(sessionWorkDir, CLAUDE_LOCAL_SETTINGS);
  const text = await session.readTextFile({ path, abortSignal });
  if (text === null) return;
  const settings = parseSettings(
    text,
    `${CLAUDE_LOCAL_SETTINGS} in the session's working directory`,
  );
  const kept = mergeHookGroups(settings, new Set(previous.hookGroups), {});
  if (kept !== undefined) {
    await session.writeTextFile({
      path,
      content: `${JSON.stringify(kept, null, 2)}\n`,
      abortSignal,
    });
  } else {
    await runScript(
      session,
      { script: PREPARE, args: [CLAUDE_LOCAL_SETTINGS], directory: sessionWorkDir },
      abortSignal,
    );
  }
}

async function readManifest({
  session,
  sessionWorkDir,
  abortSignal,
}: SyncSessionFilesInput): Promise<Manifest> {
  const text = await session.readTextFile({
    path: posix.join(sessionWorkDir, MANIFEST),
    abortSignal,
  });
  if (text === null) return EMPTY;
  try {
    const manifest = JSON.parse(text) as Partial<Manifest>;
    return manifest.version === 1 ? { ...EMPTY, ...manifest } : EMPTY;
  } catch {
    return EMPTY;
  }
}
