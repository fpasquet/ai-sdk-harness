import { HomeLayout } from 'fumadocs-ui/layouts/home';
import Link from 'next/link';

import { Footer } from '@/components/footer';
import { DOCS_BASE_PATH, GITHUB_URL, SITE_NAME } from '@/lib/constants';

export default function NotFound() {
  return (
    <HomeLayout
      githubUrl={GITHUB_URL}
      links={[{ active: 'nested-url', text: 'Documentation', url: DOCS_BASE_PATH }]}
      nav={{ title: SITE_NAME, url: '/' }}
    >
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
        <p className="text-sm font-semibold tracking-widest text-fd-primary uppercase">404</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-fd-foreground">
          This page could not be found
        </h1>
        <div className="mt-8 flex gap-3">
          <Link
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground"
            href="/"
          >
            Back home
          </Link>
          <Link
            className="rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-semibold text-fd-foreground"
            href={DOCS_BASE_PATH}
          >
            Browse the docs
          </Link>
        </div>
      </main>
      <Footer className="border-t border-fd-border bg-fd-card/30" />
    </HomeLayout>
  );
}
