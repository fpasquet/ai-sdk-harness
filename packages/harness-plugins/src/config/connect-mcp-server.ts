import type { ResolvedMcpServer } from '../definitions/plugin.js';
import type { HostMcpClient } from './resolve-plugins.js';

/**
 * Connects to `server` from your server with `@ai-sdk/mcp`: over HTTP, or by starting a stdio
 * server on this host. What `resolvePlugins` uses when it is given no `connectMcpServer`.
 *
 * `@ai-sdk/mcp` is an optional peer dependency, imported here only, once a server is connected:
 * an application without MCP servers on its server never installs nor loads it. The imports are
 * hidden from webpack and Turbopack, which would otherwise refuse to build an application that
 * does not have it; one that bundles for a deployment of traced files only passes its own
 * `connectMcpServer`.
 */
export async function connectWithAiSdk(server: ResolvedMcpServer): Promise<HostMcpClient> {
  const { createMCPClient } = await importAiSdkMcp(
    () => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '@ai-sdk/mcp'),
  );
  if (server.type === 'http') {
    return createMCPClient({
      transport: {
        type: 'http',
        url: server.url,
        ...(server.headers && { headers: server.headers }),
      },
    });
  }
  const { Experimental_StdioMCPTransport } = await importAiSdkMcp(
    () => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '@ai-sdk/mcp/mcp-stdio'),
  );
  return createMCPClient({ transport: new Experimental_StdioMCPTransport(server) });
}

/**
 * `load()`, or, when `@ai-sdk/mcp` is not installed, an error that says how to fix it rather than
 * the loader's: Node's `ERR_MODULE_NOT_FOUND`, or a bundler's `MODULE_NOT_FOUND`.
 */
export async function importAiSdkMcp<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isMissingAiSdkMcp(error)) throw error;
    throw new Error(
      'Connecting an MCP server from your server needs @ai-sdk/mcp, an optional peer dependency of ai-sdk-harness-plugins: install it, or pass connectMcpServer to resolvePlugins().',
      { cause: error },
    );
  }
}

function isMissingAiSdkMcp(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as Error & { code?: unknown };
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    /['"]@ai-sdk\/mcp(?:\/[^'"]*)?['"]/.test(error.message)
  );
}
