import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Geist, Geist_Mono } from 'next/font/google';

import { TooltipProvider } from '@/components/ui/tooltip';

import './globals.css';

const geistSans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Coding agents in a Docker Sandbox',
  description:
    'An AI SDK HarnessAgent running Claude Code or Codex in a local Docker Sandbox, via sbx.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${geistSans.variable} ${geistMono.variable}`} lang="en">
      <body className="font-sans antialiased">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
