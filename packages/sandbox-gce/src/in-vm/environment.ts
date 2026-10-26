import type { AgentConfig } from '../protocol/agent.js';

import { proxyRoute } from '../protocol/proxy-routes.js';

/** Where the sandbox's commands run, and as whom. */
export interface CommandSettings {
  user: string;
  home: string;
  workingDirectory: string;
  path: string;
}

/**
 * The hosts no proxy is used for: the machine's own, the proxy itself, and the private ranges,
 * where Docker puts its containers.
 */
export function noProxy(config: AgentConfig): string {
  return [
    'localhost',
    '127.0.0.1',
    new URL(config.proxy).hostname,
    '172.16.0.0/12',
    '192.168.0.0/16',
  ].join(',');
}

/**
 * The variables a command runs with: the sandbox's, its base URLs routed through the egress proxy,
 * then the command's own. A command's own value for a base URL variable is routed too: a harness
 * that points its client at the real API still goes through the proxy. Before the service configured
 * the agent, commands get no proxy: the firewall leaves them no way out.
 */
export function commandEnvironment(
  settings: CommandSettings,
  config: AgentConfig | undefined,
  env: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const variables: Record<string, string> = {
    PATH: settings.path,
    HOME: settings.home,
    USER: settings.user,
    LOGNAME: settings.user,
    LANG: 'C.UTF-8',
  };
  if (config === undefined) return { ...variables, ...env };
  const origin = new URL(config.proxy).origin;
  const route = (url: string): string => proxyRoute(url, origin) ?? url;
  const excluded = noProxy(config);
  Object.assign(variables, {
    // Everything else leaves through the proxy: package managers, git and Node.js read these.
    HTTPS_PROXY: origin,
    HTTP_PROXY: origin,
    https_proxy: origin,
    http_proxy: origin,
    NO_PROXY: excluded,
    no_proxy: excluded,
    NODE_USE_ENV_PROXY: '1',
  });
  for (const [name, url] of Object.entries(config.baseUrls)) variables[name] = route(url);
  for (const [name, value] of Object.entries(env)) {
    variables[name] = name in config.baseUrls ? route(value) : value;
  }
  return variables;
}
