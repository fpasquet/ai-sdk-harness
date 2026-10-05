export const SITE_NAME = 'ai-sdk-harness';
export const SITE_TAGLINE = 'Community packages for AI SDK harnesses';
export const SITE_DESCRIPTION =
  'Open-source packages for the Vercel AI SDK harnesses: run Claude Code, Codex and other coding agents in a local Docker Sandbox microVM with ai-sdk-sandbox-sbx.';
export const GITHUB_URL = 'https://github.com/fpasquet/ai-sdk-harness';
export const AUTHOR_NAME = 'Fabien Pasquet';
export const AUTHOR_URL = 'https://github.com/fpasquet';

/**
 * Public base URL of the deployed documentation site. Override with the
 * NEXT_PUBLIC_SITE_URL environment variable to point at a different domain.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://ai-sdk-harness.vercel.app'
).replace(/\/$/, '');

export const GOOGLE_SITE_VERIFICATION = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION ?? '';

export const DOCS_BASE_PATH = '/docs';
export const DOCS_CONTENT_DIR = 'content/docs';
