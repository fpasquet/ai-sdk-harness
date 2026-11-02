---
'ai-sdk-harness-plugins': patch
---

A `sandbox-command` tool of a plugin can run a script of the plugin: `${PLUGIN_ROOT}` (or `${CLAUDE_PLUGIN_ROOT}`) in its `command` points at the plugin's `files`, as it does in a hook's command and in a stdio MCP server run in the sandbox.

```ts
definePlugin({
  name: 'counter',
  description: 'Counts words.',
  tools: {
    count: {
      type: 'sandbox-command',
      description: 'Count the words',
      command: '"${PLUGIN_ROOT}/count.sh"',
    },
  },
  files: [
    {
      path: 'count.sh',
      content: '#!/bin/sh\nprintf "%s" "$INPUT_TEXT" | wc -w\n',
      executable: true,
    },
  ],
});
```

A tool runs in the sandbox's default working directory and never learns which session it serves, so `withPlugins()` writes these files for it under the sandbox's `$HOME`, in `.ai-sdk-harness/plugin-files/<plugin>-<hash>/`, a directory named after their content: sessions sharing a sandbox, each with its own version of the plugin, never overwrite each other's, and a directory already written is not written again. `${PLUGIN_ROOT}` becomes `$HOME/…`, which the shell expands: quote it with double quotes. `definePlugin()` used to refuse `${PLUGIN_ROOT}` in a `sandbox-command`; it now refuses it only in a plugin without files, and `defineItem()` in a tool on its own, which has none.
