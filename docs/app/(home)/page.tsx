import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import {
  ArrowRight,
  Box,
  ExternalLink,
  KeyRound,
  Layers,
  Network,
  RotateCcw,
  Terminal,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

import { GITHUB_URL } from '@/lib/constants';
import { JsonLd, softwareSourceCodeJsonLd, webSiteJsonLd } from '@/lib/json-ld';

export const metadata: Metadata = {
  alternates: {
    canonical: '/',
  },
};

interface Feature {
  description: string;
  icon: LucideIcon;
  title: string;
}

const FEATURES: Feature[] = [
  {
    icon: Box,
    title: 'A microVM per sandbox',
    description:
      'Docker Sandboxes run each agent in its own lightweight VM, with its own Docker daemon, not a container sharing your kernel.',
  },
  {
    icon: KeyRound,
    title: 'Credentials stay on the host',
    description:
      'The sandbox only ever sees a placeholder: the Docker Sandboxes proxy swaps the real token in on its way to the API.',
  },
  {
    icon: Layers,
    title: 'Harness installed once',
    description:
      'Pass agent.getSandboxTemplate(): the first sandbox is baked into a local image, every later one starts from it in seconds.',
  },
  {
    icon: Network,
    title: 'Loopback-only ports',
    description:
      'The harness bridge port is published on 127.0.0.1, on demand, on a port picked free on the host.',
  },
  {
    icon: RotateCcw,
    title: 'Resume across processes',
    description:
      'Name the sandbox, keep its files, reattach to it later with resumeSbxNetworkSandboxSession().',
  },
  {
    icon: Terminal,
    title: 'Nothing runs on the host',
    description:
      'Every command and file operation is an sbx exec into the VM. Variables are forwarded by name, never on a command line.',
  },
];

const USAGE = `import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

const agent = new HarnessAgent({ harness: createClaudeCode() });

const sandboxSession = await createSbxNetworkSandboxSession({
  ports: [4000],
  setup: ['npm install --global pnpm@10'],
  template: await agent.getSandboxTemplate(),
});
const session = await agent.createSession({ sandboxSession });

const { text } = await agent.generate({ session, prompt: 'Write fizzbuzz in Rust and run it' });`;

export default function LandingPage() {
  return (
    <main className="relative flex flex-1 flex-col">
      <JsonLd data={webSiteJsonLd()} />
      <JsonLd data={softwareSourceCodeJsonLd()} />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[640px] grid-backdrop"
      />

      <section className="relative mx-auto flex w-full max-w-6xl flex-col items-center px-4 pt-20 pb-12 text-center md:pt-28">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-background px-3 py-1 text-xs font-medium text-fd-muted-foreground">
          <span className="size-1.5 rounded-full bg-vercel-blue" /> For the Vercel AI SDK harnesses
        </span>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tighter text-fd-foreground md:text-6xl">
          Coding agents in a local microVM
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-fd-muted-foreground">
          <code className="rounded-md border border-fd-border bg-fd-muted px-1.5 py-0.5 text-sm text-fd-foreground">
            ai-sdk-sandbox-sbx
          </code>{' '}
          runs a <code className="text-sm text-fd-foreground">HarnessAgent</code> (Claude Code,
          Codex, OpenCode…) in a{' '}
          <a
            className="text-fd-foreground underline underline-offset-4"
            href="https://docs.docker.com/ai/sandboxes/"
          >
            Docker Sandbox
          </a>{' '}
          on your machine, through the <code className="text-sm text-fd-foreground">sbx</code> CLI.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            className="inline-flex h-10 items-center gap-2 rounded-full bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-85"
            href="/docs/getting-started"
          >
            Get started <ArrowRight className="size-4" />
          </Link>
          <a
            className="inline-flex h-10 items-center gap-2 rounded-full border border-fd-border bg-fd-background px-5 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
            href={GITHUB_URL}
            rel="noreferrer noopener"
            target="_blank"
          >
            View on GitHub <ExternalLink className="size-4" />
          </a>
        </div>
        <div className="mt-14 w-full max-w-3xl text-left">
          <DynamicCodeBlock code={USAGE} lang="ts" />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-fd-foreground md:text-3xl">
          A chat with Claude Code or Codex, in a sandbox
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          The Next.js example: <code className="text-sm">useChat</code> on one side, a{' '}
          <code className="text-sm">HarnessAgent</code> running Claude Code or Codex in a Docker
          Sandbox on the other. Every command the agent runs, it runs in the microVM.
        </p>
        <Link
          className="mt-10 block overflow-hidden rounded-xl border border-fd-border shadow-sm"
          href="/docs/examples/next-chat"
        >
          <Image
            alt="The Next.js example: Claude Code wrote a script, ran it with its bash tool in the sandbox, and answered with a table"
            className="h-auto w-full"
            height={1000}
            priority
            sizes="(max-width: 1152px) 100vw, 1152px"
            src="/screenshots/next-chat/conversation.png"
            width={1440}
          />
        </Link>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-fd-border md:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              className="-mr-px -mb-px border-r border-b border-fd-border bg-fd-background p-6"
              key={title}
            >
              <div className="mb-3 flex items-center gap-3">
                <Icon className="size-5 text-fd-muted-foreground" />
                <h3 className="font-medium text-fd-foreground">{title}</h3>
              </div>
              <p className="text-sm text-fd-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
