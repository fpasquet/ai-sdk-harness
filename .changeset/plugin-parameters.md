---
'ai-sdk-harness-plugins': patch
---

`definePlugin()` and `defineItem()` check the parameters of a tool: an input schema whose `required` lists what its `properties` do not (an issue at `inputSchema.required.<index>`), and a `sandbox-command` whose `command` reads an `INPUT_<KEY>` no property sets, or cites `${PLUGIN_ROOT}`, which it never replaces (an issue at `command`), are refused. `lintPlugin(plugin)` and `lintItem(item)` list, by field, what is accepted but likely a mistake: a property of a `sandbox-command` nothing reads (`unread-input`), a command whose prompt reads an argument its `argumentHint` does not announce (`argument-beyond-hint`), one it announces unread (`unread-argument`), or no argument at all (`appended-arguments`). `inputVariable(key)`, `citedInputVariables(command)` and `citedArguments(prompt)` read a text by the same rules. `expandCommand()` now leaves what the arguments hold as it is: a `$1` or a `$&` among them is no longer replaced.
