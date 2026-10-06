import { loader } from 'fumadocs-core/source';

import { docs } from '@/.source/server';
import { DOCS_BASE_PATH } from '@/lib/constants';

export const source = loader({
  baseUrl: DOCS_BASE_PATH,
  source: docs.toFumadocsSource(),
});

// The site is a static export: every generated file needs an extension, both so
// the host serves the right Content-Type and so the docs index (empty slug)
// does not collide with the directory of its child pages.
const OG_IMAGE_FILE = 'image.png';
const MARKDOWN_FILE = 'content.md';

/** Route segments of a page's Open Graph image, under `/og/docs`. */
export function getPageImageSegments(slugs: string[]): string[] {
  return [...slugs, OG_IMAGE_FILE];
}

/** Route segments of a page's raw Markdown, under `/llms.mdx/docs`. */
export function getPageMarkdownSegments(slugs: string[]): string[] {
  return [...slugs, MARKDOWN_FILE];
}

/** The page slugs encoded in `getPageImageSegments` / `getPageMarkdownSegments`. */
export function getPageSlugs(segments: string[]): string[] {
  return segments.slice(0, -1);
}
