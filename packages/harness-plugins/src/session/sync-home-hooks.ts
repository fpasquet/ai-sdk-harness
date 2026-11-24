import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

import { posix } from 'node:path';

import { HOOK_GATE, HOOK_GATE_SCRIPT } from '../runtimes/claude-code.js';
import { addHookGroups, parseSettings } from './local-settings.js';
import { homeOf, PREPARE, runScript } from './sandbox-shell.js';

/** The user's settings, the ones Claude Code still reads. */
const USER_SETTINGS = '.claude/settings.json';

export interface SyncHomeHooksInput {
  session: SandboxSession;
  hookGroups: Readonly<Record<string, unknown[]>>;
  abortSignal?: AbortSignal;
}

/**
 * Adds the hook groups to `$HOME/.claude/settings.json`, beside the settings and hooks it has, and
 * writes the gate they run through. A group stays for the sandbox's life, as another session may
 * have its hook: in a session that has not, the gate does nothing.
 */
export async function syncHomeHooks({
  session,
  hookGroups,
  abortSignal,
}: SyncHomeHooksInput): Promise<void> {
  if (Object.values(hookGroups).every((groups) => groups.length === 0)) return;
  const home = await homeOf(session, abortSignal);
  const directories = [posix.dirname(HOOK_GATE), posix.dirname(USER_SETTINGS)];
  await runScript(
    session,
    { script: PREPARE, args: ['--', ...directories], directory: home },
    abortSignal,
  );
  await session.writeTextFile({
    path: posix.join(home, HOOK_GATE),
    content: HOOK_GATE_SCRIPT,
    abortSignal,
  });
  const path = posix.join(home, USER_SETTINGS);
  const text = await session.readTextFile({ path, abortSignal });
  const settings = addHookGroups(
    parseSettings(text, `$HOME/${USER_SETTINGS} in the sandbox`),
    hookGroups,
  );
  if (settings === undefined) return;
  await session.writeTextFile({
    path,
    content: `${JSON.stringify(settings, null, 2)}\n`,
    abortSignal,
  });
}
