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
    // Copies its supervisor from next to its own module, and lets the sandbox read srt's helpers.
    'ai-sdk-sandbox-runtime',
    '@anthropic-ai/sandbox-runtime',
  ],
};

export default config;
