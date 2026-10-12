import type { PluginRuntime } from './plugin-runtime.js';

import { claudeCodeRuntime } from './claude-code.js';
import { codexRuntime } from './codex.js';
import { genericRuntime } from './generic.js';

/** The runtimes this package knows the features of, by harness id. */
export const KNOWN_RUNTIMES: readonly PluginRuntime[] = [claudeCodeRuntime, codexRuntime];

/** How plugins reach the runtime of harness `harnessId`. */
export function runtimeFor(harnessId: string): PluginRuntime {
  return (
    KNOWN_RUNTIMES.find((runtime) => runtime.harnessId === harnessId) ?? genericRuntime(harnessId)
  );
}
