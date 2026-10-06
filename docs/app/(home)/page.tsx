import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import {
  ArrowRight,
  Box,
  Cloud,
  ExternalLink,
  KeyRound,
  Laptop,
  Layers,
  Moon,
  Network,
  RotateCcw,
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
    title: 'Nothing runs in your app',
    description:
      'Every command and file operation of the agent runs in its sandbox: a microVM, or a Cloud Run sandbox with no network of its own.',
  },
  {
    icon: KeyRound,
    title: 'Credentials stay outside',
    description:
      'The sandbox only ever sees a placeholder: a proxy outside it swaps the real token in on its way to the model API.',
  },
  {
    icon: Layers,
    title: 'Harness installed once',
    description:
      'Pass agent.getSandboxTemplate(): the first sandbox is saved as a template, every later one starts from it in seconds.',
  },
  {
    icon: Network,
    title: 'No port left open',
    description:
      'The harness bridge is published on the loopback by sbx, or tunnelled through a Cloud Run service behind IAM.',
  },
  {
    icon: RotateCcw,
    title: 'Resume across processes',
    description:
      'Name the sandbox and reattach to it later, from the same process or another one, its files still there.',
  },
  {
    icon: Moon,
    title: 'Scale to zero',
    description:
      'A suspended Cloud Run sandbox waits as a snapshot on Cloud Storage: nothing runs, nothing is billed between turns.',
  },
];

interface SandboxPackage {
  description: string;
  href: string;
  icon: LucideIcon;
  name: string;
  points: string[];
  status: string;
  title: string;
}

const PACKAGES: SandboxPackage[] = [
  {
    icon: Laptop,
    name: 'ai-sdk-sandbox-sbx',
    title: 'On your machine',
    status: 'Stable',
    href: '/docs/packages/sandbox-sbx',
    description:
      'A Docker Sandbox microVM, driven through the sbx CLI, on your machine or in Docker Sandboxes Cloud.',
    points: [
      'A lightweight VM with its own Docker daemon',
      'Mount your project, or a private clone of it',
      'Ports on 127.0.0.1 only',
    ],
  },
  {
    icon: Cloud,
    name: 'ai-sdk-sandbox-cloud-run',
    title: 'On Google Cloud',
    status: 'Stable',
    href: '/docs/packages/sandbox-cloud-run',
    description:
      'A Cloud Run sandbox per session, run by a service you deploy in your own Google Cloud project.',
    points: [
      'Suspended to Cloud Storage between turns',
      'No network but an egress proxy and its allowed hosts',
      'Calls authenticated by Cloud Run IAM',
    ],
  },
];

const USAGE_SBX = `import { HarnessAgent } from '@ai-sdk/harness/agent';
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

const USAGE_CLOUD_RUN = `import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCloudRunNetworkSandboxSession } from 'ai-sdk-sandbox-cloud-run';

const agent = new HarnessAgent({ harness: createClaudeCode() });

const sandboxSession = await createCloudRunNetworkSandboxSession({
  url: process.env.CLOUD_RUN_SANDBOX_URL!, // gcloud run services describe prints it
  ports: [4000],
  allowedHosts: ['registry.npmjs.org'],
  template: await agent.getSandboxTemplate(),
});
const session = await agent.createSession({ sandboxSession });

const { text } = await agent.generate({ session, prompt: 'Write fizzbuzz in Rust and run it' });
await sandboxSession.stop(); // suspended to Cloud Storage: nothing billed until it resumes`;

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
          Coding agents in a sandbox, on your machine or in the cloud
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-fd-muted-foreground">
          Community packages that give a{' '}
          <code className="text-sm text-fd-foreground">HarnessAgent</code> (Claude Code, Codex,
          OpenCode…) its sandbox: a{' '}
          <a
            className="text-fd-foreground underline underline-offset-4"
            href="https://docs.docker.com/ai/sandboxes/"
          >
            Docker Sandbox
          </a>{' '}
          microVM on your machine, or a{' '}
          <a
            className="text-fd-foreground underline underline-offset-4"
            href="https://docs.cloud.google.com/run/docs/code-execution"
          >
            Cloud Run sandbox
          </a>{' '}
          on Google Cloud, scaled to zero between turns.
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
          <Tabs items={['Docker Sandboxes', 'Cloud Run']}>
            <Tab value="Docker Sandboxes">
              <DynamicCodeBlock code={USAGE_SBX} lang="ts" />
            </Tab>
            <Tab value="Cloud Run">
              <DynamicCodeBlock code={USAGE_CLOUD_RUN} lang="ts" />
            </Tab>
          </Tabs>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-fd-foreground md:text-3xl">
          Pick your sandbox
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          Both packages return the same{' '}
          <code className="text-sm">HarnessV1NetworkSandboxSession</code>: switching from one to the
          other is a matter of which function creates it.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          {PACKAGES.map(({ icon: Icon, name, title, status, href, description, points }) => (
            <Link
              className="group flex flex-col rounded-xl border border-fd-border bg-fd-background p-6 transition-colors hover:bg-fd-accent"
              href={href}
              key={name}
            >
              <div className="flex items-center gap-3">
                <Icon className="size-5 text-fd-muted-foreground" />
                <h3 className="font-medium text-fd-foreground">{title}</h3>
                <span className="ml-auto rounded-full border border-fd-border px-2 py-0.5 text-xs text-fd-muted-foreground">
                  {status}
                </span>
              </div>
              <code className="mt-3 text-sm text-fd-foreground">{name}</code>
              <p className="mt-2 text-sm text-fd-muted-foreground">{description}</p>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-fd-muted-foreground">
                {points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <span className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-fd-foreground">
                Read the docs{' '}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-fd-foreground md:text-3xl">
          A chat with Claude Code or Codex, in a sandbox
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          The Next.js example: <code className="text-sm">useChat</code> on one side, a{' '}
          <code className="text-sm">HarnessAgent</code> running Claude Code or Codex in a Docker
          Sandbox, or a Cloud Run sandbox, on the other. Every command the agent runs, it runs in
          the sandbox.
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
