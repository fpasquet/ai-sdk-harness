import type { Schema, Tool } from '@ai-sdk/provider-utils';

import { asSchema } from '@ai-sdk/provider-utils';

import type { Plugin, PluginHookEvent, PluginTool } from '../definitions/plugin.js';
import type { PluginFeature } from '../runtimes/plugin-runtime.js';

import { listSlashCommands } from '../commands/expand-command.js';
import { toolInputSchema } from '../config/input-schema.js';
import { isToolDefinition } from '../config/plugin-schema.js';
import { hookNameOf } from '../definitions/plugin.js';
import { KNOWN_RUNTIMES } from '../runtimes/runtime-for.js';

/** A JSON Schema, as the AI SDK gives a tool's input schema. */
export type JsonSchema = Awaited<Schema['jsonSchema']>;

/**
 * What a plugin is, for the person choosing it: safe to send to a browser. It never holds the code
 * of a tool, the command of a hook, the prompt of a command, the instructions of a subagent, the
 * content of a skill or a rule, nor the URL, headers or environment of an MCP server.
 */
export interface PluginDescription {
  name: string;
  description: string;
  version?: string;
  tools: { name: string; description: string; inputSchema: JsonSchema }[];
  /** Each with the name a user calls it by, `/<name>`, as `expandCommand` expands it. */
  skills: { name: string; invocation: string; description: string }[];
  /** Each with the files it is for: every file when `paths` is absent. */
  rules: { name: string; description: string; paths?: string[] }[];
  commands: { name: string; invocation: string; description: string; argumentHint?: string }[];
  hooks: { name: string; event: PluginHookEvent; matcher?: string; description?: string }[];
  subagents: { name: string; description: string; tools?: string[]; model?: string }[];
  mcpServers: { name: string; type: 'http' | 'stdio'; runIn?: 'host' | 'sandbox' }[];
  /**
   * For each runtime this package knows (`claude-code`, `codex`), the features of the plugin it
   * cannot take. Empty when the plugin works there in full.
   */
  unsupported: Record<string, PluginFeature[]>;
}

/**
 * The public description of `plugin`. Async: a tool's schema may resolve lazily. `tools` are those
 * your application registers, that a `registered` tool definition names.
 */
export async function describePlugin(
  plugin: Plugin,
  tools: Record<string, Tool> = {},
): Promise<PluginDescription> {
  return {
    name: plugin.name,
    description: plugin.description,
    ...(plugin.version !== undefined && { version: plugin.version }),
    tools: await Promise.all(
      Object.entries(plugin.tools ?? {}).map(([name, written]) =>
        toolDescription(name, describable(written, tools)),
      ),
    ),
    skills: listSlashCommands([plugin])
      .filter(({ kind }) => kind === 'skill')
      .map(({ name, invocation, description }) => ({ name, invocation, description })),
    rules: (plugin.rules ?? []).map(({ name, description = '', paths }) => ({
      name,
      description,
      ...(paths !== undefined && { paths }),
    })),
    commands: listSlashCommands([plugin])
      .filter(({ kind }) => kind === 'command')
      .map(({ kind: _kind, plugin: _plugin, ...command }) => command),
    hooks: (plugin.hooks ?? []).map((hook, index) => ({
      name: hookNameOf(hook, index),
      event: hook.event,
      ...(hook.matcher !== undefined && { matcher: hook.matcher }),
      ...(hook.description !== undefined && { description: hook.description }),
    })),
    subagents: (plugin.subagents ?? []).map(({ name, description, tools, model }) => ({
      name,
      description,
      ...(tools !== undefined && { tools }),
      ...(model !== undefined && { model }),
    })),
    mcpServers: Object.entries(plugin.mcpServers ?? {}).map(([name, server]) => {
      const { runIn } = server as { runIn?: 'host' | 'sandbox' };
      return { name, type: server.type, ...(runIn !== undefined && { runIn }) };
    }),
    unsupported: unsupportedOf(plugin),
  };
}

function unsupportedOf(plugin: Plugin): Record<string, PluginFeature[]> {
  const present: PluginFeature[] = [
    ...((plugin.hooks ?? []).length > 0 ? (['hooks'] as const) : []),
    ...((plugin.subagents ?? []).length > 0 ? (['subagents'] as const) : []),
    ...(Object.keys(plugin.mcpServers ?? {}).length > 0 ? (['mcpServers'] as const) : []),
  ];
  return Object.fromEntries(
    KNOWN_RUNTIMES.map((runtime) => [
      runtime.harnessId,
      present.filter((feature) => !runtime.supports[feature]),
    ]),
  );
}

/** A tool as its description reads it: a definition by its data, a registered one by its tool. */
function describable(tool: PluginTool, registered: Record<string, Tool>): Tool {
  if (!isToolDefinition(tool)) return tool;
  if (tool.type === 'registered') {
    return (
      registered[tool.ref] ?? {
        inputSchema: toolInputSchema(undefined),
      }
    );
  }
  return {
    description: tool.description,
    inputSchema: toolInputSchema(tool.inputSchema),
  };
}

async function toolDescription(
  name: string,
  tool: Tool,
): Promise<PluginDescription['tools'][number]> {
  return {
    name,
    description: typeof tool.description === 'string' ? tool.description : '',
    // Plain JSON: what a schema library returns may carry prototypes a client cannot take.
    inputSchema: JSON.parse(
      JSON.stringify(await asSchema(tool.inputSchema).jsonSchema),
    ) as JsonSchema,
  };
}
