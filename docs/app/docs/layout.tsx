import type { ReactNode } from 'react';

import { DocsLayout } from 'fumadocs-ui/layouts/docs';

import { GITHUB_URL, SITE_NAME } from '@/lib/constants';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      githubUrl={GITHUB_URL}
      nav={{ title: SITE_NAME, url: '/' }}
      tree={source.getPageTree()}
    >
      {children}
    </DocsLayout>
  );
}
