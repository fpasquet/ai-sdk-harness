import { defineConfig, defineDocs, frontmatterSchema, remarkInclude } from 'fumadocs-mdx/config';
import lastModified from 'fumadocs-mdx/plugins/last-modified';
import { z } from 'zod';

import { DOCS_CONTENT_DIR, SITE_URL } from './lib/constants';

interface MdastNode {
  children?: MdastNode[];
  depth?: number;
  type?: string;
  url?: string;
  value?: string;
}

/**
 * Included READMEs open with a top-level `# package-name` heading, which
 * repeats the page title Fumadocs already renders as the page's `<h1>`. Drop
 * that first heading, and demote any later `# H1` so a page keeps one `<h1>`.
 */
function remarkReadmeTitle() {
  return (tree: MdastNode): void => {
    let titleDropped = false;
    const visit = (node: MdastNode): void => {
      if (!node.children) return;
      node.children = node.children.filter((child) => {
        const isH1 = child.type === 'heading' && child.depth === 1;
        if (isH1 && !titleDropped) {
          titleDropped = true;
          return false;
        }
        if (isH1) child.depth = 2;
        return true;
      });
      node.children.forEach(visit);
    };
    visit(tree);
  };
}

/**
 * READMEs carry raw HTML blocks (badges, `<p align="center">`) that GitHub and
 * npm render but that produce unhandled `raw` HAST nodes in MDX. Strip them.
 */
function remarkStripRawHtml() {
  return (tree: MdastNode): void => {
    const strip = (node: MdastNode): void => {
      if (node.children) {
        node.children = node.children.filter((child) => child.type !== 'html');
        node.children.forEach(strip);
      }
    };
    strip(tree);
  };
}

/**
 * READMEs link to sibling READMEs by relative path (`../sandbox-sbx/README.md`)
 * so the link works on GitHub. Inside the site, rewrite them to the page that
 * includes that README: `packages/<dir>` → `/docs/packages/<dir>`,
 * `examples/<dir>` → `/docs/examples/<dir>`.
 */
function remarkReadmeLinks() {
  return (tree: MdastNode): void => {
    const visit = (node: MdastNode): void => {
      if (
        node.type === 'link' &&
        typeof node.url === 'string' &&
        !node.url.startsWith('http') &&
        node.url.includes('README.md')
      ) {
        const match = /(packages|examples)\/([\w-]+)\/README\.md(#[\w-]*)?$/.exec(node.url);
        if (match) {
          const [, kind, dir, anchor = ''] = match;
          node.url = `/docs/${kind}/${dir}${anchor}`;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/**
 * READMEs show the screenshots of `docs/public/screenshots/` by a path that
 * works where they are read: relative on GitHub, absolute on npm. Inside the
 * site, any of them becomes the web-root `/screenshots/...`.
 */
const SCREENSHOTS_MARKER = 'screenshots/';
function remarkLocalScreenshots() {
  return (tree: MdastNode): void => {
    const visit = (node: MdastNode): void => {
      if (node.type === 'image' && typeof node.url === 'string') {
        const index = node.url.indexOf(SCREENSHOTS_MARKER);
        if (index !== -1) node.url = `/${node.url.slice(index)}`;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/**
 * READMEs link to docs pages by absolute URL so the link resolves on npm and
 * GitHub. Inside the site, strip our own origin so those links navigate
 * in-site, in the same tab.
 */
const OWN_ORIGINS = Array.from(new Set(['https://ai-sdk-harness.vercel.app', SITE_URL]));
function remarkInternalLinks() {
  return (tree: MdastNode): void => {
    const visit = (node: MdastNode): void => {
      if (node.type === 'link' && typeof node.url === 'string') {
        const url = node.url;
        const origin = OWN_ORIGINS.find((own) => url.startsWith(own));
        if (origin) node.url = url.slice(origin.length) || '/';
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const docs = defineDocs({
  dir: DOCS_CONTENT_DIR,
  docs: {
    // `title`/`description` drive the sidebar label, the page <h1> and the
    // on-page lede. The optional `seo` object overrides only the `<title>`,
    // meta description and Open Graph tags.
    schema: frontmatterSchema.extend({
      seo: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
        })
        .optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  // Git-based last modified dates, surfaced as `page.data.lastModified`.
  plugins: [lastModified()],
  mdxOptions: {
    // Runs right after `remarkInclude`, so the READMEs it pulls in are cleaned
    // up like the hand-written pages.
    remarkPlugins: (plugins) => {
      const includeIndex = plugins.findIndex(
        (plugin) =>
          plugin === remarkInclude || (Array.isArray(plugin) && plugin[0] === remarkInclude),
      );
      const next = [...plugins];
      next.splice(
        includeIndex === -1 ? 0 : includeIndex + 1,
        0,
        remarkStripRawHtml as (typeof plugins)[number],
        remarkReadmeTitle as (typeof plugins)[number],
        remarkLocalScreenshots as (typeof plugins)[number],
        remarkReadmeLinks as (typeof plugins)[number],
        remarkInternalLinks as (typeof plugins)[number],
      );
      return next;
    },
    rehypeCodeOptions: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
