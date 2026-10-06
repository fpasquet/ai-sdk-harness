import type { ImageResponse } from 'next/og';

import { SITE_NAME, SITE_TAGLINE } from '@/lib/constants';
import { OG_IMAGE_SIZE, renderOGImage } from '@/lib/og-template';

export const alt = `${SITE_NAME} - ${SITE_TAGLINE}`;
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-static';

export default function OpenGraphImage(): ImageResponse {
  return renderOGImage({
    title: SITE_TAGLINE,
    description:
      'Run Claude Code, Codex and other coding agents in a Docker Sandbox microVM or a Cloud Run sandbox.',
  });
}
