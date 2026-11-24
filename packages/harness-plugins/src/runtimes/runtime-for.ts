import type { PluginRuntime } from './plugin-runtime.js';

import { claudeCodeOwnSandboxRuntime, claudeCodeRuntime } from './claude-code.js';
import { codexRuntime } from './codex.js';
import { genericRuntime } from './generic.js';

/** The runtimes this package knows the features of, by harness id. */
export const KNOWN_RUNTIMES: readonly PluginRuntime[] = [claudeCodeRuntime, codexRuntime];

/**
 * How plugins reach the runtime of harness `harnessId`; `ownSandbox` when the sandbox, and its
 * `$HOME`, is the session's own, which changes how Claude Code takes hooks.
 */
export function runtimeFor(
  harnessId: string,
  { ownSandbox = false }: { ownSandbox?: boolean } = {},
): PluginRuntime {
  if (ownSandbox && harnessId === claudeCodeRuntime.harnessId) return claudeCodeOwnSandboxRuntime;
  return (
    KNOWN_RUNTIMES.find((runtime) => runtime.harnessId === harnessId) ?? genericRuntime(harnessId)
  );
}
