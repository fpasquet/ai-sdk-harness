import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import { HOOK_GATE, HOOK_GATE_SCRIPT, isGateGroup } from '../runtimes/claude-code.js';
import { groupKey, parseSettings, replaceHookGroups } from './local-settings.js';
import { homeOf, PREPARE, runScript } from './sandbox-shell.js';
import { STATE_DIR } from './sync-session-files.js';

/** The user's settings, the ones Claude Code still reads. */
const USER_SETTINGS = '.claude/settings.json';
/** The hook groups the plugins wrote as they declare them, so that a resume can take them back. */
const MANIFEST = `${STATE_DIR}/home-hooks.json`;

interface Manifest {
  version: 1;
  hookGroups: string[];
}

export interface SyncHomeHooksInput {
  session: SandboxSession;
  hookGroups: Readonly<Record<string, unknown[]>>;
  /**
   * Whether the groups are the hooks as the plugins declare them, in a sandbox that is the
   * session's own: they replace those the plugins wrote before, the gate's included.
   */
  direct?: boolean;
  abortSignal?: AbortSignal;
}

/**
 * Writes the hook groups in `$HOME/.claude/settings.json`, beside the settings and hooks it has,
 * and takes back the groups an earlier call wrote directly.
 *
 * - Through the gate, they are added to those of the other sessions and stay for the sandbox's
 *   life, as another session may have their hook: in a session that has not, the gate does nothing.
 * - Directly, they replace every group the plugins wrote, the gate's included: the sandbox is the
 *   session's own.
 *
 * A group the plugins did not write is never taken out, even when one of theirs is alike.
 */
export async function syncHomeHooks({
  session,
  hookGroups,
  direct = false,
  abortSignal,
}: SyncHomeHooksInput): Promise<void> {
  const home = await homeOf(session, abortSignal);
  const manifestPath = posix.join(home, MANIFEST);
  const previous = await readManifest(session, manifestPath, abortSignal);
  const none = Object.values(hookGroups).every((groups) => groups.length === 0);
  // Directly, the gate's groups may still be there to take out.
  if (none && previous.length === 0 && !direct) return;

  const directories = [STATE_DIR, posix.dirname(USER_SETTINGS)];
  await runScript(
    session,
    { script: PREPARE, args: ['--', ...directories], directory: home },
    abortSignal,
  );
  if (!direct && !none) {
    await session.writeTextFile({
      path: posix.join(home, HOOK_GATE),
      content: HOOK_GATE_SCRIPT,
      abortSignal,
    });
  }
  const written = new Set(previous);
  const added = await writeSettings({
    session,
    home,
    hookGroups,
    abortSignal,
    taken: (event, group) => written.has(groupKey(event, group)) || (direct && isGateGroup(group)),
  });
  // The gate's groups need no manifest: they stay, and a direct call knows them by their command.
  const owned = direct ? added : [];
  if (previous.length === 0 && owned.length === 0) return;
  const manifest: Manifest = { version: 1, hookGroups: owned };
  await session.writeTextFile({
    path: manifestPath,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    abortSignal,
  });
}

/**
 * Replaces in `$HOME/.claude/settings.json` the groups `taken` says are the plugins' with
 * `hookGroups`, and removes the file once nothing is left in it. The keys of the groups it added.
 */
async function writeSettings({
  session,
  home,
  hookGroups,
  abortSignal,
  taken,
}: Omit<SyncHomeHooksInput, 'direct'> & {
  home: string;
  taken: (event: string, group: unknown) => boolean;
}): Promise<string[]> {
  const path = posix.join(home, USER_SETTINGS);
  const text = await session.readTextFile({ path, abortSignal });
  const { settings, added } = replaceHookGroups(
    parseSettings(text, `$HOME/${USER_SETTINGS} in the sandbox`),
    hookGroups,
    taken,
  );
  if (settings === undefined) return added;
  if (Object.keys(settings).length === 0) {
    // Nothing is left of a file that held the plugins' hooks alone.
    await runScript(
      session,
      { script: PREPARE, args: [USER_SETTINGS], directory: home },
      abortSignal,
    );
  } else {
    await session.writeTextFile({
      path,
      content: `${JSON.stringify(settings, null, 2)}\n`,
      abortSignal,
    });
  }
  return added;
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
    return manifest.version === 1 && Array.isArray(manifest.hookGroups)
      ? manifest.hookGroups.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}
