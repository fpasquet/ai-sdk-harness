import type { NextConfig } from 'next';

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
  // Fully static site (`out/`), deployed to Cloudflare Pages.
  output: 'export',
  // No image optimization server on a static host: `next/image` serves the originals.
  images: { unoptimized: true },
};

export default withMDX(config);
