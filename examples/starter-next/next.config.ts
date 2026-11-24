import type { NextConfig } from 'next';

const config: NextConfig = {
  // The harness reads its sandbox bridge from files next to its own module, which a bundle would
  // leave behind: these run on the server only, straight from node_modules.
  serverExternalPackages: [
    '@ai-sdk/harness',
    '@ai-sdk/harness-claude-code',
    'ai-sdk-sandbox-sbx',
    'ai-sdk-harness-sessions',
    // Runs git on this host for a repository of this machine.
    'ai-sdk-harness-workspace',
  ],
};

export default config;
