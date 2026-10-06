import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '@/lib/source';

export const revalidate = false;

// Self-hosted, free full-text search. The site is a static export, so the whole
// index is exported at build time and queried in the browser by the search
// dialog (`components/search.tsx`).
export const { staticGET: GET } = createFromSource(source);
