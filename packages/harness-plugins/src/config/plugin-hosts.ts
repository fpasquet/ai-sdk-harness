import type { Plugin } from '../definitions/plugin.js';

import { isToolDefinition } from './plugin-schema.js';

/** The hosts plugins reach, by where they are reached from, each list unique and sorted. */
export interface PluginHosts {
  /**
   * Reached from the sandbox: what its network policy must let through (`allowedHosts`). The
   * host of each `http` MCP server with `runIn: 'sandbox'`, and the `network.hosts` of each plugin
   * — or item on its own — with anything in the sandbox: a skill, a rule, a command, a hook, a
   * subagent, a file, a `sandbox-command` tool, an MCP server with `runIn: 'sandbox'`.
   */
  sandbox: string[];
  /**
   * Reached from your server: the host of each `http` tool and of each `http` MCP server your
   * server connects to, and the `network.hosts` of a plugin — or an item on its own — whose parts
   * all run there: tools of code, `http` or `registered` ones, and MCP servers your server
   * connects to.
   */
  server: string[];
}

/**
 * The hosts `plugins` reach, read before they are resolved, in lower case: from the sandbox, and
 * from your server. An `http` tool or MCP server gives the host of its URL — its `{key}`
 * placeholders sit after its origin —, and a plugin's `network.hosts` go with its parts: to the
 * sandbox when any of them runs there, to your server otherwise.
 */
export function pluginHosts(plugins: readonly Plugin[]): PluginHosts {
  const each = plugins.map(hostsOf);
  return {
    sandbox: sorted(each.flatMap(({ sandbox }) => sandbox)),
    server: sorted(each.flatMap(({ server }) => server)),
  };
}

/** The hosts one plugin reaches, as {@link pluginHosts} splits them; empty for a bad URL. */
function hostsOf(plugin: Plugin): PluginHosts {
  const tools = Object.values(plugin.tools ?? {}).flatMap((tool) =>
    isToolDefinition(tool) && tool.type === 'http' ? [hostOf(tool.url)] : [],
  );
  const servers = Object.values(plugin.mcpServers ?? {}).filter((server) => server.type === 'http');
  const serversIn = (sandbox: boolean): string[] =>
    servers.filter(({ runIn }) => (runIn === 'sandbox') === sandbox).map(({ url }) => hostOf(url));
  const declared = (plugin.network?.hosts ?? []).map((host) => host.toLowerCase());
  const inside = inSandbox(plugin);
  return {
    sandbox: [...serversIn(true), ...(inside ? declared : [])],
    server: [...tools, ...serversIn(false), ...(inside ? [] : declared)],
  };
}

/**
 * Whether anything of `plugin` runs in the sandbox, or reaches the agent there; a plugin with no
 * part at all counts as one, its declared hosts the sandbox's.
 */
function inSandbox(plugin: Plugin): boolean {
  const tools = Object.values(plugin.tools ?? {});
  const servers = Object.values(plugin.mcpServers ?? {});
  const parts = [
    plugin.skills,
    plugin.rules,
    plugin.commands,
    plugin.hooks,
    plugin.subagents,
    plugin.files,
  ];
  return (
    parts.some((list) => (list ?? []).length > 0) ||
    tools.some((tool) => isToolDefinition(tool) && tool.type === 'sandbox-command') ||
    servers.some((server) => server.runIn === 'sandbox') ||
    tools.length + servers.length === 0
  );
}

/** Unique, sorted, without the empty host of a URL that names none. */
const sorted = (hosts: readonly string[]): string[] =>
  [...new Set(hosts)].filter((host) => host !== '').sort();

/** The host of `url`, read from its origin alone; empty for what is not an http(s) URL. */
function hostOf(url: string): string {
  const origin = /^https?:\/\/[^/?#]+/i.exec(url)?.[0];
  return (origin === undefined ? undefined : URL.parse(origin)?.hostname) ?? '';
}
