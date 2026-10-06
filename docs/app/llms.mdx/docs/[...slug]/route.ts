import { notFound } from 'next/navigation';

import { getLLMText } from '@/lib/get-llm-text';
import { getPageMarkdownSegments, getPageSlugs, source } from '@/lib/source';

interface RouteContext {
  params: Promise<{ slug: string[] }>;
}

export const revalidate = false;

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: getPageMarkdownSegments(page.slugs) }));
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { slug } = await params;
  const page = source.getPage(getPageSlugs(slug));
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown' },
  });
}
