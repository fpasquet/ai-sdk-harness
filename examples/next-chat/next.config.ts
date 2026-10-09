import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The harnesses read their sandbox bridge from files next to their own module
  // (`new URL('./bridge/…', import.meta.url)`), which a bundle would leave behind. These run on
  // the server only, straight from node_modules.
  serverExternalPackages: [
    '@ai-sdk/harness',
    '@ai-sdk/harness-claude-code',
    '@ai-sdk/harness-codex',
    'ai-sdk-sandbox-sbx',
    'ai-sdk-sandbox-cloud-run',
    // Starts stdio MCP servers with cross-spawn, which a bundle would break.
    '@ai-sdk/mcp',
  ],
};

export default config;
