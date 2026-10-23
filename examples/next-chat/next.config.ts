import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The harnesses read their sandbox bridge from files next to their own module
  // (`new URL('./bridge/…', import.meta.url)`), which a bundle would leave behind. These run on
  // the server only, straight from node_modules.
  serverExternalPackages: [
    '@ai-sdk/harness',
    '@ai-sdk/harness-claude-code',
    '@ai-sdk/harness-cline',
    '@ai-sdk/harness-codex',
    '@ai-sdk/harness-cursor',
    '@ai-sdk/harness-deepagents',
    '@ai-sdk/harness-github-copilot',
    '@ai-sdk/harness-grok-build',
    '@ai-sdk/harness-opencode',
    // Pi, Cline and fx run in this process: fx on libfx, a native addon.
    '@ai-sdk/harness-fx',
    '@ai-sdk/harness-pi',
    'ai-sdk-sandbox-sbx',
    'ai-sdk-sandbox-cloud-run',
    // A native addon, loaded from its platform package at runtime.
    'ai-sdk-sandbox-microsandbox',
    'microsandbox',
    // Copies its supervisor from next to its own module, and lets the sandbox read srt's helpers.
    'ai-sdk-sandbox-runtime',
    '@anthropic-ai/sandbox-runtime',
    'ai-sdk-harness-sessions',
    // Runs git on this host for hostRepository().
    'ai-sdk-harness-workspace',
    // Starts stdio MCP servers with cross-spawn, which a bundle would break.
    '@ai-sdk/mcp',
  ],
};

export default config;
