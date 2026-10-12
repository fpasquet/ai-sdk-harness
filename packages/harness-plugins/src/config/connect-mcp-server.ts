import type { ResolvedMcpServer } from '../definitions/plugin.js';
import type { HostMcpClient } from './resolve-plugins.js';

/**
 * Connects to `server` from your server with `@ai-sdk/mcp`: over HTTP, or by starting a stdio
 * server on this host. What `resolvePlugins` uses when it is given no `connectMcpServer`.
 *
 * `@ai-sdk/mcp` is imported here only, once a server is connected: an application without MCP
 * servers never loads it. The specifiers are literal, for a bundler to follow them.
 */
export async function connectWithAiSdk(server: ResolvedMcpServer): Promise<HostMcpClient> {
  const { createMCPClient } = await import('@ai-sdk/mcp');
  if (server.type === 'http') {
    return createMCPClient({
      transport: {
        type: 'http',
        url: server.url,
        ...(server.headers && { headers: server.headers }),
      },
    });
  }
  const { Experimental_StdioMCPTransport } = await import('@ai-sdk/mcp/mcp-stdio');
  return createMCPClient({ transport: new Experimental_StdioMCPTransport(server) });
}
