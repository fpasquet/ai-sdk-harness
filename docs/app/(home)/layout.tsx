import type { ReactNode } from 'react';

import { HomeLayout } from 'fumadocs-ui/layouts/home';

import { Footer } from '@/components/footer';
import { DOCS_BASE_PATH, GITHUB_URL, SITE_NAME } from '@/lib/constants';

export default function HomeRootLayout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout
      githubUrl={GITHUB_URL}
      links={[{ active: 'nested-url', text: 'Documentation', url: DOCS_BASE_PATH }]}
      nav={{ title: SITE_NAME, url: '/' }}
    >
      {children}
      <Footer className="border-t border-fd-border bg-fd-card/30" />
    </HomeLayout>
  );
}
