import type { ToolSet } from '@ai-sdk/provider-utils';

import type { Plugin } from '../definitions/plugin.js';

import { checkPlugin } from '../definitions/plugin.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';

/**
 * What gives the tools of an MCP server as AI SDK tools: the `MCPClient` of `@ai-sdk/mcp`, or
 * anything with the same `tools()`.
 */
export interface McpToolSource {
  tools(): PromiseLike<ToolSet>;
}

export interface McpToolsPluginOptions {
  /** A kebab-case slug: the plugin's name. */
  name: string;
  /** One sentence: what the server is for. */
  description: string;
  version?: string;
  /** A connected MCP client, such as `await createMCPClient({ transport })` of `@ai-sdk/mcp`. */
  client: McpToolSource;
  /**
   * The tools of the server the agent may call, by their name on the server. Every tool when
   * absent. A name the server does not have is refused.
   */
  allowedTools?: readonly string[];
  /**
   * Put before each tool's name, so that the tools of two servers never collide. Characters a
   * model cannot take in a tool name become `_`.
   *
   * @defaultValue `<name>_`
   */
  prefix?: string;
}

/**
 * A plugin of the tools of an MCP server **your server** is connected to. The runtime calls them
 * like any tool of a plugin, over the harness bridge, and your client calls the MCP server: its
 * URL, its credentials and its process stay on your server, never in the sandbox, whatever the
 * runtime. Close the client when the agent is done with it.
 *
 * ```ts
 * const client = await createMCPClient({ transport: { type: 'http', url, headers } });
 * const linear = await mcpToolsPlugin({ name: 'linear', description: 'Linear issues.', client });
 * ```
 *
 * Throws {@link InvalidPluginError} when `allowedTools` names a tool the server does not have.
 */
export async function mcpToolsPlugin({
  name,
  description,
  version,
  client,
  allowedTools,
  prefix = `${name}_`,
}: McpToolsPluginOptions): Promise<Plugin> {
  const offered = await client.tools();
  const unknown = (allowedTools ?? []).filter((tool) => !(tool in offered));
  if (unknown.length > 0) {
    throw new InvalidPluginError(`its MCP server has no tool ${unknown.join(', ')}.`, name);
  }
  const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
  const tools = Object.fromEntries(
    Object.entries(offered)
      .filter(([tool]) => allowed === undefined || allowed.has(tool))
      .map(([tool, definition]) => [
        `${prefix}${tool}`.replace(/[^A-Za-z0-9_-]/g, '_'),
        definition,
      ]),
  );
  const plugin = { name, description, ...(version !== undefined && { version }), tools };
  checkPlugin(plugin);
  return plugin;
}
