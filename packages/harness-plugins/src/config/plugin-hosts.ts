import type { Plugin } from '../definitions/plugin.js';

import { isToolDefinition } from './plugin-schema.js';

/**
 * The hosts `plugins` reach, unique and sorted: the host of the URL of each `http` tool — its
 * `{key}` placeholders sit after its origin — and of each `http` MCP server, and the
 * `network.hosts` each plugin declares, in lower case. What a network policy that lets only some
 * hosts through (`allowedHosts`) needs to know of them.
 */
export function pluginHosts(plugins: readonly Plugin[]): string[] {
  const hosts = new Set(plugins.flatMap(hostsOf).filter((host) => host !== ''));
  return [...hosts].sort();
}

/** The hosts one plugin reaches, an empty one for a URL that names none. */
function hostsOf(plugin: Plugin): string[] {
  const urls = [
    ...Object.values(plugin.tools ?? {}).flatMap((tool) =>
      isToolDefinition(tool) && tool.type === 'http' ? [tool.url] : [],
    ),
    ...Object.values(plugin.mcpServers ?? {}).flatMap((server) =>
      server.type === 'http' ? [server.url] : [],
    ),
  ];
  return [...(plugin.network?.hosts ?? []).map((host) => host.toLowerCase()), ...urls.map(hostOf)];
}

/** The host of `url`, read from its origin alone, which `{key}` placeholders never reach. */
function hostOf(url: string): string {
  const origin = /^https?:\/\/[^/?#]+/i.exec(url)?.[0];
  return (origin === undefined ? undefined : URL.parse(origin)?.hostname) ?? '';
}
