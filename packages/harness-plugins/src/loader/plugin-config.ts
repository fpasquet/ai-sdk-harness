import { join } from 'node:path';

import type { PluginHook, PluginHookEvent, PluginMcpServer } from '../definitions/plugin.js';

import { PluginLoadError } from '../errors/plugin-load-error.js';
import { readJsonFile } from './plugin-directory.js';

/** A Claude Code hook handler, as `hooks.json` writes it. */
interface Handler {
  type?: unknown;
  command?: unknown;
  prompt?: unknown;
  timeout?: unknown;
}

/**
 * The hooks of a plugin: `hooks/hooks.json`, or what `plugin.json#hooks` gives instead — a path to
 * such a file, or the object itself. Handlers other than `command` and `prompt` are left out.
 */
export async function readHooks(root: string, fromManifest: unknown): Promise<PluginHook[]> {
  const config = await configOf(root, fromManifest, 'hooks/hooks.json');
  const byEvent = asRecord(asRecord(config).hooks);
  return Object.entries(byEvent).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group: unknown) => {
      const { matcher, hooks } = asRecord(group);
      return (Array.isArray(hooks) ? (hooks as Handler[]) : []).flatMap((handler) =>
        hookOf(
          event as PluginHookEvent,
          typeof matcher === 'string' ? matcher : undefined,
          handler,
        ),
      );
    }),
  );
}

/**
 * The MCP servers of a plugin: `.mcp.json`, or what `plugin.json#mcpServers` gives instead. Both
 * `{ "mcpServers": { … } }` and the bare map are read; `sse` servers are read as `http`. A stdio
 * server runs in the sandbox, from the plugin's files; an HTTP one is connected by your server.
 */
export async function readMcpServers(
  root: string,
  fromManifest: unknown,
): Promise<Record<string, PluginMcpServer>> {
  const config = asRecord(await configOf(root, fromManifest, '.mcp.json'));
  const servers = 'mcpServers' in config ? asRecord(config.mcpServers) : config;
  const read: Record<string, PluginMcpServer> = {};
  for (const [name, value] of Object.entries(servers)) {
    const server = asRecord(value);
    if (typeof server.url === 'string') {
      read[name] = { type: 'http', url: server.url, ...stringRecord('headers', server.headers) };
    } else if (typeof server.command === 'string') {
      // Shipped with the plugin, it starts from its files, where they are: in the sandbox.
      read[name] = {
        type: 'stdio',
        runIn: 'sandbox',
        command: server.command,
        ...(Array.isArray(server.args) && { args: server.args.map(String) }),
        ...stringRecord('env', server.env),
      };
    } else {
      throw new PluginLoadError(root, `the MCP server "${name}" has neither a url nor a command.`);
    }
  }
  return read;
}

function hookOf(
  event: PluginHookEvent,
  matcher: string | undefined,
  handler: Handler,
): PluginHook[] {
  const base = {
    event,
    ...(matcher !== undefined && { matcher }),
    ...(typeof handler.timeout === 'number' && { timeout: handler.timeout }),
  };
  if (handler.type === 'command' && typeof handler.command === 'string') {
    return [{ ...base, command: handler.command }];
  }
  if (handler.type === 'prompt' && typeof handler.prompt === 'string') {
    return [{ ...base, prompt: handler.prompt }];
  }
  return [];
}

/** The configuration `fromManifest` gives — inline, or as a path — or the default file's. */
async function configOf(
  root: string,
  fromManifest: unknown,
  defaultPath: string,
): Promise<unknown> {
  if (typeof fromManifest === 'object' && fromManifest !== null) return fromManifest;
  const path = typeof fromManifest === 'string' ? fromManifest : defaultPath;
  return (await readJsonFile(join(root, path))) ?? {};
}

function stringRecord<KEY extends string>(
  key: KEY,
  value: unknown,
): Partial<Record<KEY, Record<string, string>>> {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return {};
  return {
    [key]: Object.fromEntries(Object.entries(record).map(([name, item]) => [name, String(item)])),
  } as Record<KEY, Record<string, string>>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
