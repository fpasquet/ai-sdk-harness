import 'fumadocs-ui/style.css';

import './global.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { RootProvider } from 'fumadocs-ui/provider/next';
import { Geist, Geist_Mono } from 'next/font/google';

import {
  AUTHOR_NAME,
  AUTHOR_URL,
  GOOGLE_SITE_VERIFICATION,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from '@/lib/constants';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  icons: {
    icon: [{ type: 'image/svg+xml', url: '/favicon.svg' }],
  },
  title: {
    default: `${SITE_NAME} - ${SITE_TAGLINE}`,
    template: `${SITE_NAME} - %s`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: AUTHOR_NAME, url: AUTHOR_URL }],
  creator: AUTHOR_NAME,
  keywords: [
    'ai sdk',
    'ai sdk harness',
    'harness agent',
    'docker sandboxes',
    'sbx',
    'sandbox',
    'microvm',
    'claude code',
    'codex',
    'coding agent',
    'typescript',
  ],
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
  ...(GOOGLE_SITE_VERIFICATION && {
    verification: { google: GOOGLE_SITE_VERIFICATION },
  }),
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      className={`${geistSans.variable} ${geistMono.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
