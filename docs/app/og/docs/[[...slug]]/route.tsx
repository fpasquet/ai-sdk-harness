import { notFound } from 'next/navigation';

import { renderOGImage } from '@/lib/og-template';
import { source } from '@/lib/source';

interface RouteContext {
  params: Promise<{ slug?: string[] }>;
}

export const revalidate = false;

export function generateStaticParams() {
  return source.generateParams();
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return renderOGImage({
    title: page.data.seo?.title ?? page.data.title,
    description: page.data.seo?.description ?? page.data.description,
  });
}
