import type { PluginRuntime } from './plugin-runtime.js';

import { EMPTY_LAYOUT } from './plugin-runtime.js';

/** A runtime this package does not know: it takes tools, skills, commands, and rules as instructions. */
export const genericRuntime = (harnessId: string): PluginRuntime => ({
  harnessId,
  supports: { hooks: false, mcpServers: false, subagents: false },
  rules: 'instructions',
  mcpServer: (server) => server,
  layout: () => EMPTY_LAYOUT,
});
