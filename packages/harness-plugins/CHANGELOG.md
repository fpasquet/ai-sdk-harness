# ai-sdk-harness-plugins

## 0.2.0

### Minor Changes

- dd4c839: `@ai-sdk/mcp` is now an optional peer dependency, as the other `@ai-sdk/*` packages are: install it beside `ai-sdk-harness-plugins` when your server connects to MCP servers itself — an `http` or `stdio` server without `runIn: 'sandbox'` — and you pass no `connectMcpServer`. An application whose MCP servers all run in the sandbox no longer installs it, and one that uses it picks its version, in step with its `ai` and `@ai-sdk/provider-utils`, rather than getting a second copy of them. Without it, `resolvePlugins()` and `catalog.resolve()` fail with an error that says to install it or to pass `connectMcpServer`, instead of the loader's. Its imports are hidden from webpack and Turbopack, so that an application without it still builds; a build that copies only the files it traces, such as Next.js's `output: 'standalone'` with Turbopack, may leave it out: pass your own `connectMcpServer` there.

## 0.1.3

### Patch Changes

- d372630: A plugin, or an item on its own, can declare the hosts it reaches that its definition does not show — the API a stdio MCP server started with `npx` calls, the web service a hook posts to — as `network: { hosts: ['api.example.com', '*.example.com'] }`. `definePlugin()` and `defineItem()` refuse a host that is not a host name or a `*.<domain>` wildcard, the notation of `allowedHosts` in a sandbox's network policy.
  
  `resolvePlugins()` and `catalog.resolve()` return `hosts` beside the `plugins`, and `catalog.hosts(selection)` gives them without resolving anything: `{ sandbox, server }`, each unique and sorted, what a selection requires included. `sandbox` is what the sandbox's network policy must let through — the host of each `http` MCP server with `runIn: 'sandbox'`, the registry each `stdio` one with `runIn: 'sandbox'` downloads its package from when a launcher starts it (`npx`, `pnpm dlx`, `bunx`… from the npm registry, `uvx`, `pipx run` from PyPI), and the declared hosts of a plugin or item with anything in the sandbox —, `server` what your server reaches — the host of each `http` tool and of each `http` MCP server it connects to, the registry of each `stdio` one it starts, and the declared hosts of a plugin or item whose parts all run on it. `pluginHosts(plugins)` reads the same of plugins before they are resolved:
  
  ```ts
  const hosts = catalog.hosts(selection);
  const networkPolicy = { mode: 'custom', allowedHosts: [...defaults, ...hosts.sandbox] };
  ```

## 0.1.2

### Patch Changes

- 6123eda: `catalog.explain(selection)` gives each id a selection comes to, in catalog order, whether it was chosen, and the ids that require it (`requiredBy`). `catalog.deselect(selection, id)` takes an id out of a selection — an item of a plugin chosen whole leaves the plugin's other items chosen, each on its own — and gives the ids that still bring it, and what the change takes away (`removed`). `catalog.check(plugin)` — `catalog.check(item, 'item')` — tells, before an edit is saved, what the catalog could not meet with it in place of the one of its name: each of its `requires` the catalog does not have, at its field, and each `requires` elsewhere it would leave unmet. `ai-sdk-harness-plugins/selection` gives the answers of `expand()`, `explain()` and `deselect()` in a browser, from `catalog.describe()` alone. `createCatalog()` now refuses a `requires` naming what the catalog does not have with an `InvalidPluginError` whose `issues` sit at each such `requires`, within the plugin or the item (`commands.0.requires.1`, `requires.0`), and whose `plugin` is the plugin or the item at fault; its message changes accordingly.

## 0.1.1

### Patch Changes

- 4f2bb0f: `definePlugin()` and `defineItem()` check the parameters of a tool: an input schema whose `required` lists what its `properties` do not (an issue at `inputSchema.required.<index>`), and a `sandbox-command` whose `command` reads an `INPUT_<KEY>` no property sets, or cites `${PLUGIN_ROOT}`, which it never replaces (an issue at `command`), are refused. `lintPlugin(plugin)` and `lintItem(item)` list, by field, what is accepted but likely a mistake: a property of a `sandbox-command` nothing reads (`unread-input`), a command whose prompt reads an argument its `argumentHint` does not announce (`argument-beyond-hint`), one it announces unread (`unread-argument`), or no argument at all (`appended-arguments`). `inputVariable(key)`, `citedInputVariables(command)` and `citedArguments(prompt)` read a text by the same rules. `expandCommand()` now leaves what the arguments hold as it is: a `$1` or a `$&` among them is no longer replaced.
- ff585d5: A plugin can `requires`, as an item does: what it uses outside itself — an item on its own, an item of another plugin, a whole plugin —, by catalog id. Selecting the plugin in a catalog (`plugin:<name>`) selects them, and what they require in turn, each delivered as the item it is rather than copied into the plugin: a plugin follows the edits of an item published on its own. Selecting one item of the plugin brings only what that item requires. `definePlugin()` refuses a plugin that requires itself or one of its own items (an issue at `requires.<index>`), and `createCatalog()` one that requires what the catalog does not have. In `catalog.entries()`, a plugin's `requires` lists its items, then what it requires besides them; `catalog.describe()` gives the latter as the `requires` of each plugin that requires something outside itself. What a plugin requires is part of its fingerprint.

## 0.1.0

### Minor Changes

- 61d3fac: First release: plugins for AI SDK harness agents. `definePlugin()` bundles tools, skills, slash commands, hooks, subagents, MCP servers and files; `withPlugins()` applies them to the settings of a `HarnessAgent`, for Claude Code, Codex or any other runtime, and leaves out, with a warning, what the runtime cannot take. Hooks, subagents and files are written in each session's working directory at creation and at every resume, kept out of Git, and taken back when a plugin is turned off. `expandCommand()` expands `/<command> <arguments>` on your server, `pluginHarnessSettings()` gives the harness adapter the plugins' MCP servers in its own format, and `loadClaudeCodePlugin()` reads a Claude Code plugin directory as it is.
  
  MCP servers are connected by your server, with `@ai-sdk/mcp` (a dependency, loaded only once a server is connected) or your own `connectMcpServer`, and their tools handed to the agent, so their URL and credentials never reach the sandbox; a server without credentials can instead run in the sandbox (`runIn: 'sandbox'`), from the plugin's own files (`${PLUGIN_ROOT}`). `mcpToolsPlugin()` makes a plugin of an MCP client you opened yourself. Plugins are configuration: written in code or as JSON, checked alike by `definePlugin()`, with errors by field. Their tools may be AI SDK tools, or definitions that need no code — an `http` request your server makes, a command run in the sandbox, or a reference to a tool your application registers —, and secrets are references (`{ "secret": "NAME" }`) resolved on your server; `resolvePlugins()` builds them, resolves the secrets and connects the MCP servers that run on your server. `createCatalog()` makes a marketplace of plugins and of single items — tools, skills, commands, hooks, subagents, MCP servers, checked by `defineItem()` —, each with an id an agent's selection keeps: selecting an item selects what it `requires`, `resolve()` turns a selection into plugins for `withPlugins()`, `describe()` gives what a marketplace page shows, and `fingerprint()` tells when an agent must be rebuilt after an edit. `pluginJsonSchema()` and `itemJsonSchema()` give their JSON Schemas.
  
  `/<name>` calls a skill as well as a command, as in Claude Code: `expandCommand()` turns it into a request to use the skill, and `listSlashCommands()` lists the commands and skills a prompt can complete, from plugins or from their public descriptions.
  
  `InvalidPluginError.isInstance()` and `PluginLoadError.isInstance()` recognise the errors of the package even when a bundler loaded it twice, as Next.js does.
  
  The input schema of a tool written as configuration is a JSON Schema, which JSON holds, or a zod or Standard Schema in code; each `{key}` of an `http` tool's URL must be one of its required properties, since the model fills only what the schema shows.
  
  Rules are instructions the agent always follows, for every file or for the files their `paths` match: Claude Code reads them from the session's `.claude/rules/`, loading a rule with `paths` once the agent works on a matching file, and the other runtimes in the agent's instructions. A rule can be an item on its own (`rule:<name>`).
