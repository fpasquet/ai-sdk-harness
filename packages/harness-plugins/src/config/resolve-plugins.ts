import type { Tool, ToolSet } from '@ai-sdk/provider-utils';

import type {
  Plugin,
  PluginMcpServer,
  PluginTool,
  ResolvedMcpServer,
  SecretValue,
} from '../definitions/plugin.js';
import type { McpToolSource } from '../mcp/mcp-tools-plugin.js';

import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { mcpToolsPlugin } from '../mcp/mcp-tools-plugin.js';
import { connectWithAiSdk } from './connect-mcp-server.js';
import { definePlugin } from './define.js';
import { httpTool } from './http-tool.js';
import { isToolDefinition } from './plugin-schema.js';
import { sandboxCommandTool } from './sandbox-command-tool.js';

/** An MCP client your server opened for a `runIn: 'host'` server, closed by `close()`. */
export type HostMcpClient = McpToolSource & { close?: () => PromiseLike<void> | void };

/** What resolving plugins needs at runtime. */
export interface ResolveOptions {
  /**
   * Opens a client to an MCP server your server connects to, its secrets resolved. Without it,
   * `@ai-sdk/mcp` connects: pass your own for an authentication of your own, such as OAuth. As
   * `@ai-sdk/mcp` does:
   *
   * ```ts
   * connectMcpServer: (server) =>
   *   createMCPClient({
   *     transport: server.type === 'http' ? { type: 'http', url: server.url, headers: server.headers }
   *       : new Experimental_StdioMCPTransport(server),
   *   }),
   * ```
   */
  connectMcpServer?: (
    server: ResolvedMcpServer,
    context: { plugin: string; name: string },
  ) => PromiseLike<HostMcpClient>;
  /**
   * The value of the secret `name` a plugin refers to (`{ "secret": "LINEAR_TOKEN" }`): from your
   * secret manager, your environment… Throw for a secret the plugin may not have.
   */
  resolveSecret?: (name: string, context: { plugin: string }) => PromiseLike<string> | string;
}

export interface ResolvePluginsOptions extends ResolveOptions {
  /**
   * The tools your application implements, that plugins written as configuration name with
   * `{ "type": "registered", "ref": "<key>" }`.
   */
  tools?: Record<string, Tool>;
}

/** Plugins resolved, and the MCP clients opened for them. */
export interface ResolvedPlugins {
  plugins: Plugin[];
  /** Closes every MCP client opened for the plugins: call it once the agent built on them is done. */
  close: () => Promise<void>;
}

/**
 * Resolves plugins — written in code or as configuration, checked again — into plugins
 * `withPlugins` applies: tool definitions become tools, `registered` ones take your
 * application's, secrets are resolved, and each MCP server your server connects to is connected, its
 * tools added to its plugin. A plugin with none of these needs no resolving.
 *
 * Throws {@link InvalidPluginError} for an invalid plugin, a `registered` tool your application
 * does not have, a secret without `resolveSecret`, or two MCP servers of one name; rejects as
 * connecting a server does. Clients opened before the error are closed.
 */
export async function resolvePlugins(
  plugins: readonly unknown[],
  options: ResolvePluginsOptions = {},
): Promise<ResolvedPlugins> {
  return resolveChecked(
    plugins.map((plugin) => definePlugin(plugin)),
    options,
  );
}

/**
 * Refuses two MCP servers of one name: their tools, named `<server>_<tool>`, would collide. Each
 * server, in each plugin, gets a client of its own.
 */
function checkServerNames(plugins: readonly Plugin[]): void {
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    for (const name of Object.keys(plugin.mcpServers ?? {})) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new InvalidPluginError(
          `its MCP server "${name}" is also one of "${owner}".`,
          plugin.name,
        );
      }
      owners.set(name, plugin.name);
    }
  }
}

/** {@link resolvePlugins}, for plugins already checked. */
export async function resolveChecked(
  plugins: readonly Plugin[],
  options: ResolvePluginsOptions,
): Promise<ResolvedPlugins> {
  const clients: HostMcpClient[] = [];
  const close = async (): Promise<void> => {
    await Promise.allSettled(clients.splice(0).map(async (client) => client.close?.()));
  };
  try {
    checkServerNames(plugins);
    const resolved: Plugin[] = [];
    for (const plugin of plugins) resolved.push(await resolvePlugin(plugin, options, clients));
    return { plugins: resolved, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function resolvePlugin(
  plugin: Plugin,
  options: ResolvePluginsOptions,
  clients: HostMcpClient[],
): Promise<Plugin> {
  const { tools: written = {}, mcpServers = {}, ...rest } = plugin;
  const secret = secretsOf(plugin.name, options);
  const tools: ToolSet = {};
  for (const [name, tool] of Object.entries(written)) {
    tools[name] = await toolOf(plugin.name, tool, { tools: options.tools, secret });
  }
  const sandboxServers: Record<string, PluginMcpServer> = {};
  for (const [name, definition] of Object.entries(mcpServers)) {
    const server = await withSecrets(definition, secret);
    if (definition.runIn !== 'sandbox') {
      const context = { plugin: plugin.name, name, allowedTools: definition.allowedTools, server };
      Object.assign(tools, await hostTools(context, options, clients));
    } else {
      sandboxServers[name] = { ...server, runIn: 'sandbox' };
    }
  }
  return {
    ...rest,
    ...(Object.keys(tools).length > 0 && { tools }),
    ...(Object.keys(sandboxServers).length > 0 && { mcpServers: sandboxServers }),
  };
}

type Secret = (value: SecretValue) => Promise<string>;

async function toolOf(
  plugin: string,
  tool: PluginTool,
  { tools = {}, secret }: { tools?: Record<string, Tool>; secret: Secret },
): Promise<Tool> {
  if (!isToolDefinition(tool)) return tool;
  if (tool.type === 'sandbox-command') return sandboxCommandTool(tool);
  if (tool.type === 'http') return httpTool(tool, await resolveRecord(tool.headers, secret));
  const found = tools[tool.ref];
  if (found === undefined) {
    throw new InvalidPluginError(
      `its tool "${tool.ref}" is not one your application registers.`,
      plugin,
    );
  }
  return found;
}

/**
 * The tool `tool` stands for, built at once: an AI SDK tool as it is, a `sandbox-command`, an
 * `http` one without secrets. `undefined` for one that needs resolving first.
 */
export function readyTool(tool: PluginTool): Tool | undefined {
  if (!isToolDefinition(tool)) return tool;
  if (tool.type === 'sandbox-command') return sandboxCommandTool(tool);
  if (tool.type === 'http' && plainRecord(tool.headers)) {
    return httpTool(tool, (tool.headers ?? {}) as Record<string, string>);
  }
  return undefined;
}

/** Whether a record holds no secret reference. */
export const plainRecord = (record: Record<string, SecretValue> | undefined): boolean =>
  Object.values(record ?? {}).every((value) => typeof value === 'string');

/** Resolves a value: as it is, or the secret it refers to. */
function secretsOf(plugin: string, { resolveSecret }: ResolveOptions): Secret {
  return async (value) => {
    if (typeof value === 'string') return value;
    if (resolveSecret === undefined) {
      throw new InvalidPluginError(
        `it refers to the secret "${value.secret}", and no resolveSecret was given.`,
        plugin,
      );
    }
    return resolveSecret(value.secret, { plugin });
  };
}

async function resolveRecord(
  record: Record<string, SecretValue> | undefined,
  secret: Secret,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(record ?? {}).map(async ([key, value]) => [key, await secret(value)] as const),
  );
  return Object.fromEntries(entries);
}

/** The server as the runtime or a client takes it: its secrets resolved, no host fields. */
async function withSecrets(server: PluginMcpServer, secret: Secret): Promise<ResolvedMcpServer> {
  if (server.type === 'http') {
    const { runIn: _runIn, allowedTools: _allowed, headers, ...rest } = server;
    return headers === undefined
      ? rest
      : { ...rest, headers: await resolveRecord(headers, secret) };
  }
  const { runIn: _runIn, allowedTools: _allowed, env, ...rest } = server;
  return env === undefined ? rest : { ...rest, env: await resolveRecord(env, secret) };
}

async function hostTools(
  context: { plugin: string; name: string; allowedTools?: string[]; server: ResolvedMcpServer },
  { connectMcpServer }: ResolveOptions,
  clients: HostMcpClient[],
): Promise<ToolSet> {
  const client = await (connectMcpServer === undefined
    ? connectWithAiSdk(context.server)
    : connectMcpServer(context.server, { plugin: context.plugin, name: context.name }));
  clients.push(client);
  const { tools = {} } = await mcpToolsPlugin({
    name: context.plugin,
    description: '',
    client,
    prefix: `${context.name}_`,
    ...(context.allowedTools !== undefined && { allowedTools: context.allowedTools }),
  });
  return tools as ToolSet;
}
