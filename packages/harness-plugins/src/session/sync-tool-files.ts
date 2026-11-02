import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type { PluginFile } from '../definitions/plugin.js';

import { FINISH, PREPARE, runScript } from './sandbox-shell.js';
import { STATE_DIR } from './sync-session-files.js';

/**
 * Where, under the sandbox's `$HOME`, the files of a plugin go for its `sandbox-command` tools.
 * Not in the session's working directory: a tool runs in the sandbox's default one, and never
 * learns which session it serves.
 */
const TOOL_FILES_DIR = `${STATE_DIR}/plugin-files`;
/** Written last: the directory holds every file. */
const COMPLETE = '.complete';

/** The files of a plugin a `sandbox-command` tool reaches through `${PLUGIN_ROOT}`. */
export interface ToolFiles {
  /** Their directory, relative to the sandbox's `$HOME`. */
  root: string;
  files: readonly PluginFile[];
}

/**
 * The directory of `files` of plugin `plugin`, relative to `$HOME`: named after their content,
 * so that sessions sharing a sandbox, each with its own version of the plugin, never overwrite
 * each other's.
 */
export function toolFilesRoot(plugin: string, files: readonly PluginFile[]): string {
  const content = JSON.stringify(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(({ path, content, executable }) => [path, content, executable === true]),
  );
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return posix.join(TOOL_FILES_DIR, `${plugin}-${hash}`);
}

export interface SyncToolFilesInput {
  session: SandboxSession;
  tools: readonly ToolFiles[];
  abortSignal?: AbortSignal;
}

/**
 * Writes each set of files under the sandbox's `$HOME`, unless an earlier session wrote it: a
 * directory, named after its content, is never written twice. They stay for the sandbox's life.
 */
export async function syncToolFiles({
  session,
  tools,
  abortSignal,
}: SyncToolFilesInput): Promise<void> {
  if (tools.length === 0) return;
  const home = await homeOf(session, abortSignal);
  const roots = [...new Map(tools.map((tool) => [tool.root, tool])).values()];
  for (const { root, files } of roots) {
    const complete = posix.join(home, root, COMPLETE);
    if ((await session.readTextFile({ path: complete, abortSignal })) !== null) continue;
    const paths = files.map(({ path }) => posix.join(root, path));
    const directories = [...new Set([root, ...paths.map((path) => posix.dirname(path))])];
    await runScript(
      session,
      { script: PREPARE, args: ['--', ...directories], directory: home },
      abortSignal,
    );
    await session.writeTextFile({
      path: posix.join(home, STATE_DIR, '.gitignore'),
      content: '*\n',
      abortSignal,
    });
    for (const { path, content } of files) {
      await session.writeTextFile({ path: posix.join(home, root, path), content, abortSignal });
    }
    const executables = files
      .filter(({ executable }) => executable === true)
      .map(({ path }) => posix.join(root, path));
    await runScript(
      session,
      { script: FINISH, args: [...executables, '--'], directory: home },
      abortSignal,
    );
    await session.writeTextFile({ path: complete, content: '', abortSignal });
  }
}

/** The sandbox's `$HOME`, where a tool's command finds the files too. */
async function homeOf(session: SandboxSession, abortSignal?: AbortSignal): Promise<string> {
  const result = await session.run({ command: 'printf "%s" "$HOME"', abortSignal });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !posix.isAbsolute(home)) {
    throw new Error(
      `The sandbox has no absolute $HOME for the files of the plugins' tools: ${result.stderr.trim() || home}`,
    );
  }
  return home;
}
