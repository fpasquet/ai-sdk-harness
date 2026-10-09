import type { HarnessAgentSkill } from '@ai-sdk/harness/agent';
import type { FlexibleSchema, Tool } from '@ai-sdk/provider-utils';

import { InvalidPluginError } from '../errors/invalid-plugin-error.js';

/**
 * The moments of a session a hook can run at, as Claude Code names them. A runtime that has
 * hooks of its own maps them onto its events.
 */
export const PLUGIN_HOOK_EVENTS = [
  'Notification',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
] as const;
export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number];

/**
 * A slash command: the prompt that `/<name> <arguments>`, at the start of a message, stands for.
 * It is expanded on your server by {@link expandCommand}, the same way for every runtime.
 */
export interface PluginCommand {
  /** What the user types after the slash. Letters, digits, `-`, `_`; `:` separates a namespace. */
  name: string;
  /** One sentence: what the command does. Shown to the user picking it. */
  description: string;
  /** The arguments, as a hint: `<issue> [focus]`. */
  argumentHint?: string;
  /**
   * The prompt the agent receives. `$ARGUMENTS` is everything after the name, `$1` to `$9` each
   * argument (quotes keep one together); a prompt with neither gets the arguments appended.
   */
  prompt: string;
  /**
   * What it needs to work, by catalog id (`tool:search`, `mcp-server:context7`, or
   * `<plugin>/<kind>:<name>`): selecting it in a catalog selects them too.
   */
  requires?: string[];
}

/**
 * A hook: a shell command, or a prompt for a small model, that the runtime runs itself, in the
 * sandbox, at a moment of the session — out of the model's hands. For `PreToolUse`, a command that
 * exits with `2` blocks the tool call and hands its standard error to the agent.
 */
export interface PluginHook {
  /**
   * A kebab-case slug, what a catalog selects it by. `<event>-<position>` (`pretooluse-1`) when
   * absent.
   */
  name?: string;
  event: PluginHookEvent;
  /** The tools it watches, for the tool events (`Bash`, `Edit|Write`). Every tool when absent. */
  matcher?: string;
  /**
   * The shell command. It reads the event as JSON on its standard input. `${PLUGIN_ROOT}` is
   * replaced by the directory the plugin's {@link Plugin.files} are written to.
   */
  command?: string;
  /** A prompt a small model evaluates instead of a command. Claude Code only. */
  prompt?: string;
  /** Seconds before the runtime gives up on it. */
  timeout?: number;
  /** What it does, for the person turning the plugin on. Never sent to the runtime. */
  description?: string;
  /**
   * What it needs to work, by catalog id (`tool:search`, `mcp-server:context7`, or
   * `<plugin>/<kind>:<name>`): selecting it in a catalog selects them too.
   */
  requires?: string[];
}

/** A subagent: a specialist the main agent hands a task to, with instructions of its own. */
export interface PluginSubagent {
  /** A kebab-case slug, the name the agent delegates to. */
  name: string;
  /** When to delegate to it. The main agent reads it to decide. */
  description: string;
  /** Its system prompt. */
  instructions: string;
  /** The runtime tools it may use. All of the main agent's when absent. */
  tools?: string[];
  /** Its model, in the runtime's own terms (`sonnet`, `haiku`, `inherit`…). */
  model?: string;
  /**
   * What it needs to work, by catalog id (`tool:search`, `mcp-server:context7`, or
   * `<plugin>/<kind>:<name>`): selecting it in a catalog selects them too.
   */
  requires?: string[];
}

/**
 * A rule: instructions the agent always follows — for every file, or only for the files `paths`
 * matches. Claude Code reads it from `.claude/rules/`, loading a rule with `paths` once the agent
 * works on a matching file; other runtimes read it in the agent's instructions.
 */
export interface PluginRule {
  /** A kebab-case slug. */
  name: string;
  /** What it asks, for the person turning the plugin on. Never sent to the runtime. */
  description?: string;
  /** Glob patterns, from the session's working directory: `src/api/**\/*.ts`. Every file when absent. */
  paths?: string[];
  /** The instructions, in Markdown. */
  content: string;
  /**
   * What it needs to work, by catalog id (`tool:search`, `mcp-server:context7`, or
   * `<plugin>/<kind>:<name>`): selecting it in a catalog selects them too.
   */
  requires?: string[];
}

/** A skill, as `HarnessAgent` takes it, and what it needs to work. */
export type PluginSkill = HarnessAgentSkill & { requires?: string[] };

/**
 * A value written as it is, or a reference to a secret your application holds — a token, a key —,
 * resolved on your server by `resolveSecret` when the plugins are resolved. Configuration never
 * holds the secret itself.
 */
export type SecretValue = string | { secret: string };

/** What an item needs to work, by catalog id: selecting it selects them too. */
interface Requiring {
  /**
   * What it needs to work, by catalog id (`tool:search`, `mcp-server:context7`, or
   * `<plugin>/<kind>:<name>`): selecting it in a catalog selects them too.
   */
  requires?: string[];
}

/**
 * The input schema of a tool written as configuration: a JSON Schema, which JSON can hold, or —
 * in code — a zod schema, a Standard Schema or the AI SDK's `jsonSchema()`.
 */
export type InputSchema = FlexibleSchema<Record<string, unknown>> | Record<string, unknown>;

/**
 * A tool written as configuration rather than code: an HTTP request your server makes, a command
 * run in the session's sandbox, or a reference to a tool your application implements.
 */
export type ToolDefinition = Requiring &
  (
    | {
        type: 'http';
        /** What the model reads to decide when to call it. */
        description: string;
        /**
         * Its input, as the model reads it: an object, each `{key}` of `url` among its required
         * properties. No input when absent.
         */
        inputSchema?: InputSchema;
        /** @defaultValue `'GET'` */
        method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
        /**
         * The URL, its origin fixed: `{key}` in its path or query takes the input's `key`,
         * URL-encoded. The other properties of the input go in the query string of a `GET` or a
         * `DELETE`, and as a JSON body otherwise.
         */
        url: string;
        /** Sent with the request, from your server: the place for a token, as a secret. */
        headers?: Record<string, SecretValue>;
        /** @defaultValue `30` */
        timeoutSeconds?: number;
      }
    | {
        type: 'registered';
        /**
         * The name of a tool your application implements and registers (`tools` of
         * `resolvePlugins` or `createCatalog`): what a tool whose logic is code is, in a
         * configuration.
         */
        ref: string;
      }
    | {
        type: 'sandbox-command';
        /** What the model reads to decide when to call it. */
        description: string;
        /** Its input, as the model reads it: an object. No input when absent. */
        inputSchema?: InputSchema;
        /**
         * A shell command, run in the sandbox in its default working directory. The input reaches
         * it as environment variables, never spliced into the command: `INPUT` holds it as JSON,
         * and `INPUT_<KEY>` each top-level property (`INPUT_PATH` for `path`), strings as they
         * are, anything else as JSON.
         */
        command: string;
        /** @defaultValue `30` */
        timeoutSeconds?: number;
      }
  );

/** A tool of a plugin: an AI SDK tool, written in code, or a {@link ToolDefinition}. */
export type PluginTool = Tool | ToolDefinition;

/**
 * An MCP server. Your server connects to it when the plugins are resolved, and hands its tools to
 * the agent: its URL and credentials never reach the sandbox. A server without credentials can
 * instead be started by the runtime in the sandbox (`runIn: 'sandbox'`), such as a stdio server
 * shipped with the plugin's files.
 */
export type PluginMcpServer = {
  /**
   * `host`: your server connects to it, with `@ai-sdk/mcp` or your own `connectMcpServer`.
   * `sandbox`: the runtime starts or reaches it from the sandbox; it may hold no secret, since its
   * configuration is the runtime's, in the sandbox.
   *
   * @defaultValue `'host'`
   */
  runIn?: 'host' | 'sandbox';
  /** The tools the agent may call, by their name on the server. All when absent. */
  allowedTools?: string[];
} & (
  | {
      type: 'http';
      url: string;
      /** Sent with every request: the place for a token, as a secret. */
      headers?: Record<string, SecretValue>;
    }
  | {
      type: 'stdio';
      /**
       * The command that starts it. In the sandbox, it starts in the session's working directory,
       * where `${PLUGIN_ROOT}` in the command, its arguments or its environment points at the
       * plugin's files.
       */
      command: string;
      args?: string[];
      env?: Record<string, SecretValue>;
    }
);

/** An MCP server with its secrets resolved, as a client or the runtime takes it. */
export type ResolvedMcpServer =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/** A file the plugin needs in the sandbox, such as the script of a hook. */
export interface PluginFile {
  /** Relative to the plugin's directory in the sandbox (`${PLUGIN_ROOT}`). */
  path: string;
  content: string;
  /** Written with the executable bit. */
  executable?: boolean;
}

/**
 * A plugin: tools, skills, commands, hooks, subagents and MCP servers that go together. It is
 * configuration: written in code, or read from JSON — a file, a database —, checked alike by
 * `definePlugin`. Only a tool whose logic is code needs an implementation.
 */
export interface Plugin {
  /** A kebab-case slug, unique in a catalog. */
  name: string;
  /** One sentence: what the plugin is for. */
  description: string;
  version?: string;
  /**
   * Its tools, under the name of their key: AI SDK tools, run on your server, or
   * {@link ToolDefinition}s.
   */
  tools?: Record<string, PluginTool>;
  /** Instructions the agent loads when it judges them relevant. */
  skills?: PluginSkill[];
  /** Instructions the agent always follows, for every file or some. */
  rules?: PluginRule[];
  commands?: PluginCommand[];
  hooks?: PluginHook[];
  subagents?: PluginSubagent[];
  /** By server name. */
  mcpServers?: Record<string, PluginMcpServer>;
  files?: PluginFile[];
}

/** `${PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_ROOT}` as Claude Code plugins write it. */
export const PLUGIN_ROOT = /\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/g;

/** A kebab-case slug. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COMMAND_NAME = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/;
export const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** Relative, and never out of its directory. */
export const FILE_PATH = /^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$)).+$/;

/** Throws {@link InvalidPluginError} when `plugin` cannot be used as it is. */
export function checkPlugin(plugin: Plugin): void {
  const fail = (message: string): never => {
    throw new InvalidPluginError(message, plugin.name);
  };
  if (!SLUG.test(plugin.name)) fail('its name is not a kebab-case slug.');
  for (const [kind, list, pattern] of namesOf(plugin)) {
    const twice = list.find((name, index) => list.indexOf(name) !== index);
    const invalid = list.find((name) => !pattern.test(name));
    if (invalid !== undefined) fail(`the ${kind} name "${invalid}" is not valid.`);
    if (twice !== undefined) fail(`it has two ${kind}s named "${twice}".`);
  }
  for (const [index, hook] of (plugin.hooks ?? []).entries()) {
    if ((hook.command === undefined) === (hook.prompt === undefined)) {
      fail(`hook #${index + 1} (${hook.event}) needs exactly one of command and prompt.`);
    }
  }
}

/** The name of the hook at `index` of its plugin: its own, or `<event>-<position>`. */
export const hookNameOf = (hook: PluginHook, index: number): string =>
  hook.name ?? `${hook.event.toLowerCase()}-${index + 1}`;

/** The names a plugin gives, by kind, and the pattern each must match. */
function namesOf(plugin: Plugin): [kind: string, names: string[], pattern: RegExp][] {
  const named = (items: { name: string }[] = []): string[] => items.map(({ name }) => name);
  return [
    ['skill', named(plugin.skills), SLUG],
    ['rule', named(plugin.rules), SLUG],
    ['command', named(plugin.commands), COMMAND_NAME],
    ['subagent', named(plugin.subagents), SLUG],
    ['hook', (plugin.hooks ?? []).map(hookNameOf), SLUG],
    ['MCP server', Object.keys(plugin.mcpServers ?? {}), SERVER_NAME],
    ['file', (plugin.files ?? []).map(({ path }) => path), FILE_PATH],
  ];
}
