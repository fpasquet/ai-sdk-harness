import type { Metadata } from 'next';

import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';

import { AutoTypeTable } from '@/components/auto-type-table';
import { Footer } from '@/components/footer';
import { FramedImage } from '@/components/framed-image';
import { DOCS_BASE_PATH, SITE_NAME } from '@/lib/constants';
import { breadcrumbJsonLd, JsonLd, techArticleJsonLd } from '@/lib/json-ld';
import { source } from '@/lib/source';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  // `seo.*` overrides the search-facing metadata only; the page <h1>, sidebar
  // label and on-page lede keep using `title`/`description`.
  const title = page.data.seo?.title ?? page.data.title;
  const description = page.data.seo?.description ?? page.data.description;
  const ogImage = {
    url: `/og/docs/${(slug ?? []).join('/')}`,
    width: 1200,
    height: 630,
    alt: title,
  };

  return {
    title,
    description,
    alternates: { canonical: page.url },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title,
      description,
      url: page.url,
      images: [ogImage],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

export function generateStaticParams() {
  return source.generateParams();
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = `/llms.mdx/docs/${(slug ?? []).join('/')}`;

  const rawBreadcrumbs = getBreadcrumbItems(page.url, source.getPageTree(), {
    includePage: true,
    includeRoot: { url: DOCS_BASE_PATH },
  })
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      url: item.url,
    }))
    .filter((item) => item.name.length > 0);
  // Folder index pages appear twice (folder node + page itself); keep the
  // page entry, which carries the URL.
  const breadcrumbs = rawBreadcrumbs.filter(
    (item, index) => item.name !== rawBreadcrumbs[index + 1]?.name,
  );

  return (
    <DocsPage full={page.data.full} toc={page.data.toc}>
      <JsonLd
        data={techArticleJsonLd({
          title: page.data.title,
          description: page.data.description,
          url: page.url,
          lastModified: page.data.lastModified,
        })}
      />
      <JsonLd data={breadcrumbJsonLd(breadcrumbs)} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={{
            ...defaultMdxComponents,
            AutoTypeTable,
            Callout,
            Card,
            Cards,
            Step,
            Steps,
            Tab,
            Tabs,
            img: FramedImage,
          }}
        />
        <div className="mt-6 flex flex-row items-center gap-2 border-t pt-4">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover markdownUrl={markdownUrl} />
        </div>
      </DocsBody>
      <Footer />
    </DocsPage>
  );
}
