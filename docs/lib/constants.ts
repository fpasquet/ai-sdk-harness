export const SITE_NAME = 'ai-sdk-harness';
export const SITE_TAGLINE = 'Community packages for AI SDK harnesses';
/**
 * The meta description of the site: one sentence of at most ~155 characters,
 * as search engines cut it there. It names the need, not the packages, so
 * that adding a package does not leave it out of date.
 */
export const SITE_DESCRIPTION =
  'Run Claude Code, Codex and other coding agents in a sandbox with the Vercel AI SDK, locally or in the cloud, with sessions, plugins and approvals.';
export const GITHUB_URL = 'https://github.com/fpasquet/ai-sdk-harness';
export const AUTHOR_NAME = 'Fabien Pasquet';
export const AUTHOR_URL = 'https://github.com/fpasquet';

/**
 * Public base URL of the deployed documentation site. Override with the
 * NEXT_PUBLIC_SITE_URL environment variable to point at a different domain
 * (an empty value, as CI passes for an unset variable, keeps the default).
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'https://ai-sdk-harness.pages.dev'
).replace(/\/$/, '');

export const GOOGLE_SITE_VERIFICATION = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION ?? '';

export const DOCS_BASE_PATH = '/docs';
export const DOCS_CONTENT_DIR = 'content/docs';
