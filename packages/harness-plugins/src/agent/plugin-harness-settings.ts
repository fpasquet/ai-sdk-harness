import type { Plugin, PluginMcpServer, ResolvedMcpServer } from '../definitions/plugin.js';

import { PLUGIN_ROOT } from '../definitions/plugin.js';
import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { runtimeFor } from '../runtimes/runtime-for.js';
import { STATE_DIR } from '../session/sync-session-files.js';

/** What the plugins set on the harness adapter itself. */
export interface PluginHarnessSettings {
  /** The plugins' MCP servers, by name, in the runtime's own format. */
  mcpServers?: Record<string, unknown>;
}

/**
 * The settings `plugins` need on the harness adapter of `harnessId` — their MCP servers, in its
 * own format —, to spread into `createClaudeCode()` or `createCodex()`:
 *
 * ```ts
 * const harness = createClaudeCode({ ...pluginHarnessSettings('claude-code', plugins) });
 * ```
 *
 * An adapter serves every agent built on it: give each set of plugins with MCP servers an adapter
 * of its own. Empty for a runtime without MCP support. Throws {@link InvalidPluginError} when two
 * plugins name an MCP server alike.
 */
export function pluginHarnessSettings(
  harnessId: string,
  plugins: readonly Plugin[],
): PluginHarnessSettings {
  const runtime = runtimeFor(harnessId);
  if (!runtime.supports.mcpServers) return {};
  const mcpServers: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    for (const [name, server] of Object.entries(plugin.mcpServers ?? {})) {
      // Connected by your server when the plugins are resolved: none of the runtime's.
      if (server.runIn !== 'sandbox') continue;
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new InvalidPluginError(
          `its MCP server "${name}" is also one of "${owner}".`,
          plugin.name,
        );
      }
      owners.set(name, plugin.name);
      const resolved = resolvedServer(server, `its MCP server "${name}"`, plugin.name);
      mcpServers[name] = runtime.mcpServer(withPluginRoot(resolved, plugin.name));
    }
  }
  return owners.size > 0 ? { mcpServers } : {};
}

/**
 * A stdio server with `${PLUGIN_ROOT}` pointing at the plugin's files: relative to the session's
 * working directory, where the runtime starts it, since an adapter serves every session.
 */
function withPluginRoot(server: ResolvedMcpServer, plugin: string): ResolvedMcpServer {
  if (server.type !== 'stdio') return server;
  const root = `${STATE_DIR}/plugins/${plugin}`;
  const resolve = (value: string): string => value.replace(PLUGIN_ROOT, root);
  return {
    ...server,
    command: resolve(server.command),
    ...(server.args !== undefined && { args: server.args.map(resolve) }),
    ...(server.env !== undefined && {
      env: Object.fromEntries(
        Object.entries(server.env).map(([key, value]) => [key, resolve(value)]),
      ),
    }),
  };
}

/** The server as the runtime takes it; throws when it refers to a secret not yet resolved. */
function resolvedServer(server: PluginMcpServer, label: string, plugin: string): ResolvedMcpServer {
  const values = server.type === 'http' ? server.headers : server.env;
  if (Object.values(values ?? {}).some((value) => typeof value !== 'string')) {
    throw new InvalidPluginError(
      `${label} refers to a secret: resolve the plugins with resolvePlugins() first.`,
      plugin,
    );
  }
  const { runIn: _runIn, allowedTools: _allowed, ...rest } = server;
  return rest as ResolvedMcpServer;
}
