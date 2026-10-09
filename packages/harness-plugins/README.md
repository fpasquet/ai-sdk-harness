# ai-sdk-harness-plugins

<p align="center">
  <a href="https://www.npmjs.com/package/ai-sdk-harness-plugins"><img alt="npm" src="https://img.shields.io/npm/v/ai-sdk-harness-plugins" /></a>
  <a href="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fpasquet/ai-sdk-harness/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node &gt;= 24" src="https://img.shields.io/badge/node-%3E%3D24-3c873a" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
  <a href="https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Plugins for [AI SDK harness agents](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent): give Claude Code, Codex and the other runtimes `HarnessAgent` drives **tools, skills, rules, slash commands, hooks, subagents, MCP servers and files**, written in TypeScript or JSON, as whole plugins or one item at a time.

## At a glance

A plugin brings any of these, and `withPlugins()` gives them to an agent. `acme` is a sketch of every part; the plugin and the items further down are those of the [Next.js example](https://github.com/fpasquet/ai-sdk-harness/tree/main/examples/next-chat), each with a screenshot of a real turn.

```ts
import { tool } from 'ai';
import { definePlugin } from 'ai-sdk-harness-plugins';
import { z } from 'zod';

export const acme = definePlugin({
  name: 'acme',
  description: 'What the agent needs to work on Acme.',

  tools: {
    // An AI SDK tool: code, run on your server.
    deploy: tool({
      description: 'Deploy a service.',
      inputSchema: z.object({ service: z.string() }),
      execute: deploy,
    }),
    // An HTTP request your server makes, no code: {service} takes the input's `service`.
    status: {
      type: 'http',
      description: 'The status of a service.',
      inputSchema: {
        type: 'object',
        properties: { service: { type: 'string' } },
        required: ['service'],
      },
      url: 'https://status.acme.dev/{service}',
      headers: { Authorization: { secret: 'ACME_TOKEN' } },
    },
    // A shell command run in the session's sandbox, no code.
    todos: {
      type: 'sandbox-command',
      description: 'Count the TODOs.',
      command: 'git grep -c TODO',
    },
  },

  // Instructions the agent loads when it judges them relevant.
  skills: [{ name: 'acme-style', description: 'How Acme code is written.', content: 'Use …' }],

  // Instructions the agent always follows: for every file, or for the files `paths` matches.
  rules: [
    { name: 'tone', content: 'Answer in short sentences.' },
    { name: 'api', paths: ['src/api/**/*.ts'], content: 'Validate the input of every endpoint.' },
  ],

  // Prompts the user calls by name: `/release 2.1`.
  commands: [
    { name: 'release', description: 'Prepare a release', prompt: 'Prepare release $1: …' },
  ],

  // A command the runtime runs in the sandbox before each shell command: exit 2 blocks it.
  // ${PLUGIN_ROOT} is replaced by the sandbox directory the plugin's `files` are written to.
  hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: '"${PLUGIN_ROOT}/guard.sh"' }],

  // A specialist the agent delegates to.
  subagents: [{ name: 'reviewer', description: 'Reviews changes.', instructions: 'You review …' }],

  // MCP servers your server connects to: their tools reach the agent, their tokens never do.
  mcpServers: {
    linear: {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: { secret: 'LINEAR_TOKEN' } },
    },
  },

  // Files written in the sandbox, in ${PLUGIN_ROOT}: the hook's script.
  files: [{ path: 'guard.sh', content: '#!/bin/sh\n…', executable: true }],
});
```

| Part            | Runs                         | Claude Code | Codex |
| --------------- | ---------------------------- | :---------: | :---: |
| **tools**       | on your server / the sandbox |     ✅      |  ✅   |
| **skills**      | in the sandbox               |     ✅      |  ✅   |
| **rules**       | read by the agent            |     ✅      | ✅ ¹  |
| **commands**    | expanded on your server      |     ✅      |  ✅   |
| **hooks**       | in the sandbox               |     ✅      |  ❌   |
| **subagents**   | in the sandbox               |     ✅      |  ❌   |
| **MCP servers** | connected by your server     |     ✅      |  ✅   |
| **files**       | in the sandbox               |     ✅      |  ✅   |

¹ As instructions: only Claude Code loads a rule with `paths` once the agent works on a matching file.

**Secrets never appear in a plugin.** It holds a reference, `{ "secret": "LINEAR_TOKEN" }`, which your server resolves with `resolveSecret`: the value never reaches the configuration, a database or the sandbox.

The package is used two ways: give an agent **[whole plugins](#using-plugins)**, or offer **[single items](#using-items)** in a catalog and let each agent pick its own.

## Installation

```bash
pnpm add ai-sdk-harness-plugins @ai-sdk/harness @ai-sdk/harness-claude-code zod
```

## Using plugins

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { expandCommand, resolvePlugins, withPlugins } from 'ai-sdk-harness-plugins';

const { plugins, close } = await resolvePlugins([acme], {
  resolveSecret: (name) => secrets.get(name), // ACME_TOKEN, LINEAR_TOKEN…
});
const agent = new HarnessAgent(withPlugins({ harness: createClaudeCode() }, plugins));

// A command is expanded on your server, before the message reaches the agent.
const prompt = expandCommand(message, plugins)?.prompt ?? message;
await agent.stream({ session, prompt });

await close(); // closes the MCP clients, once the agent is done
```

- `resolvePlugins()` builds the tools written as configuration, resolves the secrets and connects the MCP servers. A plugin with none of these can go straight to `withPlugins()`.
- `withPlugins()` adds the tools and skills to the agent, and writes the rules, hooks, subagents and files in each session. What the runtime cannot take — hooks and subagents on Codex — is left out with a warning (`onUnsupported` to change that).
- `/<skill>` calls a skill as `/<command>` calls a command; `listSlashCommands(plugins)` lists both, for a prompt's completion.

### A plugin in JSON

Everything above can be JSON — a file, a database row —, checked by the same `definePlugin()`, whose `InvalidPluginError` lists every mistake by field; `pluginJsonSchema()` is its JSON Schema, for an editor or a form. This plugin of the [Next.js example](https://github.com/fpasquet/ai-sdk-harness/tree/main/examples/next-chat) brings a command and the MCP server it relies on:

```json
{
  "name": "library-docs",
  "description": "Up-to-date library documentation from the Context7 MCP server, connected by the server: a whole plugin kept as data.",
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    }
  },
  "commands": [
    {
      "name": "docs",
      "description": "Answer a question from a library's documentation",
      "argumentHint": "<library> <question>",
      "prompt": "Answer this question from the current documentation of the library: resolve the library id with the context7_resolve-library-id tool, then query its documentation with context7_query-docs, and cite what you used. $ARGUMENTS",
      "requires": ["mcp-server:context7"]
    }
  ]
}
```

![/docs zod: the agent calls the Context7 tools your server connects to, and answers from the documentation](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/plugin.png)

`/docs zod …`: the command is expanded on your server, and the agent calls `context7_resolve-library-id` and `context7_query-docs`, which your server connects to.

A tool whose logic is code is named in JSON, `{ "type": "registered", "ref": "acme.deploy" }`, and passed once: `resolvePlugins(plugins, { tools: { 'acme.deploy': deployTool } })`.

### Claude Code plugins

`loadClaudeCodePlugin('./plugins/commit-helper')` reads a Claude Code plugin directory — `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json` and its other files — into a plugin. A command's `allowed-tools` and `model` are not applied.

## Using items

An item is one part of a plugin on its own — a tool, a skill, a rule, a command, a hook, a subagent or an MCP server —, written as it would be in a plugin, with its `kind` and its `name`. A catalog offers items one by one, and each agent picks the ones it needs: a marketplace where adding a tool is adding a JSON document.

Here is one item of each kind, as the [Next.js example](https://github.com/fpasquet/ai-sdk-harness/tree/main/examples/next-chat) keeps it in `marketplace/items/`, and a real turn of Claude Code with it.

### A tool

```json
{
  "kind": "tool",
  "name": "npm-latest",
  "type": "http",
  "description": "Read the latest version of an npm package from the registry: its version, description, license and dependencies.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "The package name, scope included: @ai-sdk/harness"
      }
    },
    "required": ["name"],
    "additionalProperties": false
  },
  "url": "https://registry.npmjs.org/{name}/latest"
}
```

![The agent calls npm-latest with { "name": "zod" }, and reads the registry's answer.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-tool.png)

The agent calls npm-latest with { "name": "zod" }, and reads the registry's answer. An http tool: your server makes the request, `{name}` taking the input its JSON Schema declares.

### A skill

```json
{
  "kind": "skill",
  "name": "code-review",
  "description": "How to review a change. Use it whenever you review code or a diff.",
  "content": "# Reviewing a change\n\n1. Say what the change does, in one sentence.\n2. List the bugs first: what breaks, with the line.\n3. Then what is hard to read or to change, and why.\n4. End with what is good about it, if anything is."
}
```

![/code-review …: the agent loads the skill, and reviews the function it wrote the way the skill says.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-skill.png)

`/code-review …`: the agent loads the skill, and reviews the function it wrote the way the skill says.

### A rule

```json
{
  "kind": "rule",
  "name": "dependency-versions",
  "description": "Checks that dependencies are pinned, whenever the agent reads a package.json.",
  "paths": ["**/package.json"],
  "content": "When you read or edit a package.json, check the versions of its dependencies and devDependencies. End your answer with a **Dependency check** section: list each dependency whose version is not exact (a range with ^ or ~, *, or a tag such as latest) with the version to pin, or say that all are pinned."
}
```

![The agent reads package.json, the rule loads, and the answer ends with a dependency check nobody asked for.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-rule.png)

The agent reads `package.json`, the rule loads, and the answer ends with a dependency check nobody asked for.

### A command

```json
{
  "kind": "command",
  "name": "npm",
  "description": "Size an npm package up before adding it",
  "argumentHint": "<package>",
  "prompt": "Look the npm package $1 up with the npm-latest tool, then tell me in a few lines what it is, its latest version and license, and how many dependencies it would add.",
  "requires": ["tool:npm-latest"]
}
```

![/npm zod: picking the command brings the tool it requires.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-command.png)

`/npm zod`: picking the command brings the tool it `requires`.

### A hook

```json
{
  "kind": "hook",
  "name": "protect-env",
  "description": "Keeps .env files out of the conversation: the agent may not read them.",
  "event": "PreToolUse",
  "matcher": "Read|Bash|Grep",
  "command": "\"${PLUGIN_ROOT}/protect-env.sh\"",
  "timeout": 10,
  "files": [
    {
      "path": "protect-env.sh",
      "content": "#!/bin/sh\n# Claude Code hands the tool call as JSON on the standard input.\nif grep -Eq '\\.env($|[^A-Za-z])'; then\n  echo 'Blocked by the protect-env hook: .env files hold secrets, and stay out of the conversation. Ask the user for the values you need.' >&2\n  exit 2\nfi\n",
      "executable": true
    }
  ]
}
```

![Asked to read .env, the agent is blocked before the read, and told why.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-hook.png)

Asked to read `.env`, the agent is blocked before the read, and told why. Its script is among its `files`; `${PLUGIN_ROOT}` points at them.

### A subagent

```json
{
  "kind": "subagent",
  "name": "reviewer",
  "description": "Reviews the changes of the working directory. Delegate reviews to it.",
  "instructions": "You review the uncommitted changes of the working directory (git diff), following the code-review skill, and report what you found. You change nothing.",
  "tools": ["Read", "Grep", "Glob", "Bash", "Skill"],
  "requires": ["skill:code-review"]
}
```

![The agent delegates a review to reviewer, which finds the off-by-one bug.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-subagent.png)

The agent delegates a review to `reviewer`, which finds the off-by-one bug.

### An MCP server

```json
{
  "kind": "mcp-server",
  "name": "deepwiki",
  "description": "The documentation of public GitHub repositories, from DeepWiki.",
  "type": "http",
  "url": "https://mcp.deepwiki.com/mcp",
  "allowedTools": ["read_wiki_structure", "ask_wiki_question"]
}
```

![The agent asks DeepWiki about vercel/ai, with the tool your server connected: deepwiki_ask_wiki_question.](https://raw.githubusercontent.com/fpasquet/ai-sdk-harness/main/docs/public/screenshots/next-chat/item-mcp-server.png)

The agent asks DeepWiki about `vercel/ai`, with the tool your server connected: `deepwiki_ask_wiki_question`.

### A catalog

`requires` lists what an item needs. `defineItem()` checks an item, `itemJsonSchema(kind)` is the JSON Schema of each kind.

```ts
import { createCatalog } from 'ai-sdk-harness-plugins';

const catalog = createCatalog({ plugins: [libraryDocs], items });

// What an agent picked: an item, a whole plugin, or one item of a plugin.
const selection = ['command:npm', 'hook:protect-env', 'plugin:library-docs'];
const { plugins, close } = await catalog.resolve(selection, { resolveSecret });
const agent = new HarnessAgent(withPlugins({ harness: createClaudeCode() }, plugins));
```

- `catalog.describe()` is what a marketplace page shows of every plugin and item — never code, prompts or secrets: safe for a browser.
- `catalog.fingerprint(selection)` changes when what the selection resolves to is edited: key your built agents by it.

## Reference

### Tools

| Type              | Fields                                                       | Runs                                                                                                                    |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| AI SDK tool       | `tool({ description, inputSchema, execute })`                | on your server; `experimental_sandbox` in its options reaches the session's sandbox                                     |
| `http`            | `{ type, description, inputSchema, url, method?, headers? }` | on your server: `{key}` takes the input's `key`; the rest of the input is the query of a `GET`, the JSON body otherwise |
| `sandbox-command` | `{ type, description, inputSchema?, command }`               | in the sandbox, the input as `INPUT` (JSON) and `INPUT_<KEY>` environment variables, never spliced into the command     |
| `registered`      | `{ type, ref }`                                              | the tool your application passes as `tools[ref]`                                                                        |

`inputSchema` is what the model reads to call the tool: a JSON Schema, in JSON or in code, or a zod schema, in code. Without one, the tool takes no input; each `{key}` of an `http` URL must be one of its required properties, which `definePlugin()` checks.

### MCP servers

`{ type: 'http', url, headers? }` or `{ type: 'stdio', command, args?, env? }`, plus `allowedTools?`. Your server connects to each with `@ai-sdk/mcp`, and its tools reach the agent named `<server>_<tool>`; two servers of one name are refused.

- `connectMcpServer` replaces the connection, for an authentication of your own such as OAuth: `resolvePlugins(plugins, { connectMcpServer: (server, { plugin, name }) => createMCPClient(…) })`.
- `runIn: 'sandbox'` lets the runtime start the server in the sandbox instead, from the plugin's files, as a Claude Code plugin's stdio servers do. It may hold no secret, and goes to the harness adapter: `createClaudeCode({ ...pluginHarnessSettings('claude-code', plugins) })`.

### Rules, commands, hooks, files

- A rule without `paths` is always followed. With `paths`, globs from the session's working directory, Claude Code loads it once the agent reads or edits a matching file; other runtimes read every rule in the agent's instructions, each saying which files it is for.
- In a command's `prompt`, `$ARGUMENTS` is everything after the name, `$1` to `$9` each argument.
- A hook's `command` runs in the sandbox with the event as JSON on its standard input; for `PreToolUse`, exit status `2` blocks the call. It guards against mistakes, not against a hostile agent: the sandbox stays the security boundary.
- Files are written in `.ai-sdk-harness/plugins/<plugin>/` of the session's working directory; hooks, subagents and rules go to `.claude/`. All of it is kept out of Git.
- `${PLUGIN_ROOT}` is not an environment variable: in a hook's `command`, or the `command`, `args` and `env` of an MCP server run in the sandbox, the package replaces it with that directory of the plugin, `${CLAUDE_PLUGIN_ROOT}` as Claude Code plugins write it included.

## Limitations

- Codex takes no hooks nor subagents yet: its hooks must be trusted by hash, which the harness does not expose.
- A tool working in the sandbox runs in its default working directory: the harness does not hand tools the session's own.

## Development

`pnpm --filter ai-sdk-harness-plugins test:e2e` runs real Claude Code and Codex turns with plugins in a Docker Sandbox; it needs `sbx` signed in and a credential for each runtime. See [CONTRIBUTING.md](https://github.com/fpasquet/ai-sdk-harness/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/fpasquet/ai-sdk-harness/blob/main/LICENSE)
