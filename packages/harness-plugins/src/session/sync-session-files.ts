import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import type { SessionFile, SessionLayout } from '../runtimes/plugin-runtime.js';

import { CLAUDE_LOCAL_SETTINGS } from '../runtimes/claude-code.js';
import { groupKey, mergeHookGroups, parseSettings } from './local-settings.js';
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
 * Writes `layout` in the session's working directory and takes back what the previous call wrote
 * and `layout` no longer has — a plugin turned off between a session and its resume. The files
 * are kept out of Git: the state directory ignores itself, the others go to `info/exclude`.
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
  const settings = await syncSettings(input, previous);
  const executables = files.filter(({ executable }) => executable === true).map(({ path }) => path);
  const excluded = [
    ...layout.files.map(({ path }) => path),
    ...(settings.createdSettings && settings.hookGroups.length > 0 ? [CLAUDE_LOCAL_SETTINGS] : []),
  ];
  await runScript(
    session,
    { script: FINISH, args: [...executables, '--', ...excluded], directory },
    abortSignal,
  );

  const manifest: Manifest = {
    version: 1,
    files: layout.files.map(({ path }) => path),
    ...settings,
  };
  await session.writeTextFile({
    path: posix.join(directory, MANIFEST),
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    abortSignal,
  });
}

/** Merges the hook groups into `.claude/settings.local.json`, or removes the file it alone made. */
async function syncSettings(
  { session, sessionWorkDir, layout, abortSignal }: SyncSessionFilesInput,
  previous: Manifest,
): Promise<Pick<Manifest, 'createdSettings' | 'hookGroups'>> {
  const hookGroups = Object.entries(layout.hookGroups).flatMap(([event, groups]) =>
    groups.map((group) => groupKey(event, group)),
  );
  if (hookGroups.length === 0 && previous.hookGroups.length === 0) {
    return { createdSettings: previous.createdSettings, hookGroups };
  }
  const path = posix.join(sessionWorkDir, CLAUDE_LOCAL_SETTINGS);
  const text = await session.readTextFile({ path, abortSignal });
  const createdSettings = previous.hookGroups.length > 0 ? previous.createdSettings : text === null;
  const merged = mergeHookGroups(
    parseSettings(text, CLAUDE_LOCAL_SETTINGS),
    new Set(previous.hookGroups),
    layout.hookGroups,
  );
  if (merged !== undefined) {
    await session.writeTextFile({
      path,
      content: `${JSON.stringify(merged, null, 2)}\n`,
      abortSignal,
    });
  } else if (text !== null) {
    await runScript(
      session,
      { script: PREPARE, args: [CLAUDE_LOCAL_SETTINGS], directory: sessionWorkDir },
      abortSignal,
    );
  }
  return { createdSettings, hookGroups };
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
