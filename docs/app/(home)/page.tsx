import type { LucideIcon } from 'lucide-react';
import type { Metadata } from 'next';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import {
  ArrowRight,
  Box,
  Cloud,
  Database,
  ExternalLink,
  KeyRound,
  Laptop,
  Layers,
  ListChecks,
  MessagesSquare,
  Moon,
  Network,
  PauseCircle,
  Plug,
  Puzzle,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  SquareSlash,
  Workflow,
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

const PLUGIN_FEATURES: Feature[] = [
  {
    icon: Puzzle,
    title: 'One plugin, every runtime',
    description:
      'Tools, skills, rules, slash commands, hooks, subagents and MCP servers, applied to Claude Code, Codex and the other runtimes by withPlugins().',
  },
  {
    icon: ShieldCheck,
    title: 'Hooks that guard the agent',
    description:
      'A PreToolUse hook runs in the sandbox, out of the model’s hands: it blocks a command and tells the agent what to do instead.',
  },
  {
    icon: Plug,
    title: 'MCP servers where they belong',
    description:
      'Run by the runtime in the sandbox, or connected by your server so that their credentials never reach it.',
  },
  {
    icon: SquareSlash,
    title: 'Slash commands and skills',
    description:
      'Expanded on your server, the same for every runtime: /explain src, /docs zod, or any skill by its name.',
  },
  {
    icon: Workflow,
    title: 'Claude Code plugins, as they are',
    description:
      'loadClaudeCodePlugin() reads a plugin of the Claude Code marketplaces, scripts included, for any HarnessAgent.',
  },
  {
    icon: Database,
    title: 'Configuration, in code or JSON',
    description:
      'A plugin, or a single tool, skill, rule, command or subagent, is configuration: HTTP tools, secrets by reference, requirements. Only a tool whose logic is code needs code.',
  },
];

const SESSION_FEATURES: Feature[] = [
  {
    icon: MessagesSquare,
    title: 'Many conversations, one sandbox',
    description:
      'Each session works in a view of the sandbox, fork(), with a port of its own for its bridge: they run side by side.',
  },
  {
    icon: PauseCircle,
    title: 'Suspended when idle',
    description:
      'A session nobody writes to stops its harness session and frees its port; the next message resumes it where it was.',
  },
  {
    icon: ServerCog,
    title: 'Kept across restarts',
    description:
      'shutdown() suspends every session when your server stops; the next start resumes them, from a store you plug in.',
  },
  {
    icon: ShieldCheck,
    title: 'Waiting for approvals',
    description:
      'A turn paused on a tool approval waits as long as it takes, suspended or not, until continue() brings the answer.',
  },
  {
    icon: ListChecks,
    title: 'Statuses to follow',
    description:
      'preparing, busy, idle, awaiting input, suspended: subscribe() sends every change, for a list that follows them live.',
  },
  {
    icon: Layers,
    title: 'Any sandbox, any runtime',
    description:
      'A shared sandbox, a sandbox per session or your own strategy, for every HarnessAgent: Claude Code, Codex and the others.',
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

interface Shot {
  alt: string;
  /** What the screenshot shows. */
  shows: string;
  src: string;
  title: string;
  /** What the package did to get there. */
  how: string;
}

/** The sessions of the Next.js example, captured from real turns. */
const SESSION_SHOTS: Shot[] = [
  {
    src: '/screenshots/next-chat/sessions.png',
    alt: 'Two conversations of the Next.js example working at once, the others ready or suspended',
    title: 'Two conversations at once',
    shows:
      'Two conversations work at the same time in the one Docker Sandbox; the list follows each session as the server changes it.',
    how: 'sharedSandbox() gives each session a view of the sandbox with a port of its own; subscribe() sends every change to the page as server-sent events.',
  },
  {
    src: '/screenshots/next-chat/approval.png',
    alt: 'A shell command waiting for approval in the Next.js example, the conversation marked "Needs you"',
    title: 'A command waiting for approval',
    shows:
      'Claude Code asks before running a command: the conversation needs you, and the turn waits for the answer.',
    how: 'The session is awaiting-input with what it waits for; continue() reads the answer useChat sends back and resumes the turn, even after a suspension.',
  },
  {
    src: '/screenshots/next-chat/resumed.png',
    alt: 'A conversation resumed after a suspension: the agent remembers what it did',
    title: 'Suspended, then resumed',
    shows:
      'The conversation was suspended, its port handed back; the next message resumed it, and the agent answered from what it did before.',
    how: 'suspend() stops the harness session and keeps its resume state in the store; send() reattaches the sandbox and resumes the harness session from it.',
  },
];

/**
 * The plugins at work in the Next.js example, captured from real turns: a whole plugin, then an
 * item of each kind, every one of them JSON.
 */
const PLUGIN_SHOTS: Shot[] = [
  {
    src: '/screenshots/next-chat/plugin.png',
    alt: 'The /docs command of the library-docs plugin: the agent calls the Context7 MCP tools and answers from the zod documentation',
    title: 'A plugin: a command and its MCP server',
    shows:
      '/docs zod …: the agent resolves the library and queries its documentation with the Context7 tools, then answers with its source.',
    how: 'library-docs is one JSON document bringing a /docs command and the MCP server it relies on. Your server connects the MCP server and hands its tools to the agent: the server and its credentials never reach the sandbox.',
  },
  {
    src: '/screenshots/next-chat/item-tool.png',
    alt: 'The npm-latest tool, kept as data, reads the npm registry from the server',
    title: 'A tool',
    shows:
      'The agent calls npm-latest with { name: "zod" }, and reads the registry’s answer: its status and the package’s metadata.',
    how: 'An http tool in JSON: your server makes the request, {name} of its URL taking the input its JSON Schema declares. A token would be a secret reference in its headers.',
  },
  {
    src: '/screenshots/next-chat/item-skill.png',
    alt: '/code-review: the agent loads the code-review skill and reviews the function it wrote',
    title: 'A skill',
    shows:
      '/code-review …: the agent writes a function with a bug, loads the skill, and reviews it the way the skill says.',
    how: 'The skill is JSON, written where the runtime reads its skills. /<skill> asks the agent to use it; otherwise the agent loads it when its description fits.',
  },
  {
    src: '/screenshots/next-chat/item-rule.png',
    alt: 'A rule kept as data, scoped to package.json, makes the agent check the versions of the dependencies',
    title: 'A rule',
    shows:
      'The agent reads package.json to name the project, and ends with a dependency check nobody asked for.',
    how: 'The rule is JSON, scoped to **/package.json: Claude Code loads it only once the agent reads a matching file. Other runtimes read it in the agent’s instructions.',
  },
  {
    src: '/screenshots/next-chat/item-command.png',
    alt: 'The /npm command, kept as data, brings the npm-latest tool it requires and sums the zod package up',
    title: 'A command',
    shows: '/npm zod: the agent looks the package up with npm-latest, and sums it up.',
    how: 'The command is JSON, expanded into its prompt on your server. It requires tool:npm-latest: picking the command brings the tool.',
  },
  {
    src: '/screenshots/next-chat/item-hook.png',
    alt: 'The protect-env hook blocks the agent from reading the .env file',
    title: 'A hook',
    shows: 'Asked to read .env, the agent is blocked, and told why.',
    how: 'The hook is JSON, with its script among its files. Claude Code runs the script before each read or shell command; it exits with 2 on a .env file, which blocks the call. The model has no say in it.',
  },
  {
    src: '/screenshots/next-chat/item-subagent.png',
    alt: 'Claude Code delegates a review to the reviewer subagent, kept as data, which finds the bug',
    title: 'A subagent',
    shows:
      'The agent writes a function with a bug, then delegates its review to the reviewer subagent.',
    how: 'The subagent is JSON, and requires the code-review skill: both are written into the session, where Claude Code delegates to the subagent with its Agent tool.',
  },
  {
    src: '/screenshots/next-chat/item-mcp-server.png',
    alt: 'The deepwiki MCP server, kept as data: the agent asks DeepWiki about the vercel/ai repository',
    title: 'An MCP server',
    shows: 'The agent asks DeepWiki what the vercel/ai repository is, and answers from it.',
    how: 'The server is JSON, two of its tools kept with allowedTools. Your server connects it and hands its tools to the agent, named deepwiki_<tool>.',
  },
  {
    src: '/screenshots/next-chat/commands.png',
    alt: 'Typing / in the prompt lists the commands and skills of the conversation plugins',
    title: 'Commands and skills after /',
    shows:
      'Typing / lists the commands and skills the conversation picked, a Claude Code plugin’s and JSON ones included.',
    how: 'listSlashCommands() gives the list from the plugins’ public descriptions; expandCommand() turns the message into the command’s prompt on your server, the same for every runtime.',
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

const USAGE_PLUGINS = `import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { definePlugin, expandCommand, withPlugins } from 'ai-sdk-harness-plugins';

const guard = definePlugin({
  name: 'guard',
  description: 'No global installs.',
  hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: '"\${PLUGIN_ROOT}/guard.sh"' }],
  files: [{ path: 'guard.sh', content: GUARD_SCRIPT, executable: true }],
  commands: [{ name: 'review', description: 'Review the changes', prompt: 'Review: $ARGUMENTS' }],
});

const agent = new HarnessAgent(withPlugins({ harness: createClaudeCode() }, [guard]));
const session = await agent.createSession({ sandboxSession });

const message = '/review the error handling';
const prompt = expandCommand(message, [guard])?.prompt ?? message;
const { text } = await agent.generate({ session, prompt });`;

const USAGE_SESSIONS = `import { createSessionManager, sharedSandbox } from 'ai-sdk-harness-sessions';

const sessions = createSessionManager({
  agent: () => agent,
  // One sandbox for every session, each with a port of its own for its bridge.
  sandboxes: sharedSandbox({ open: openSandbox, ports: Array.from({ length: 4 }, (_, i) => 4001 + i) }),
  // Suspended after 10 minutes without a message; the next one resumes it.
  idleTimeoutMs: 10 * 60_000,
});

// A route handler: create the session with the first message, stream each turn to useChat.
await sessions.create({ id, metadata: { title: 'Fix the tests' } });
const turn = await sessions.send(id, { message, abortSignal: request.signal });
return turn.toUIMessageStreamResponse();`;

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
          Coding agents in a sandbox, with the plugins they need
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
          on Google Cloud, scaled to zero between turns. The plugins that extend it: tools, skills,
          rules, slash commands, hooks, subagents and MCP servers, for every runtime. And the
          sessions that run your users&apos; conversations with it, suspended when idle and resumed
          where they were.
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
          <Tabs items={['Docker Sandboxes', 'Cloud Run', 'Plugins', 'Sessions']}>
            <Tab value="Docker Sandboxes">
              <DynamicCodeBlock code={USAGE_SBX} lang="ts" />
            </Tab>
            <Tab value="Cloud Run">
              <DynamicCodeBlock code={USAGE_CLOUD_RUN} lang="ts" />
            </Tab>
            <Tab value="Plugins">
              <DynamicCodeBlock code={USAGE_PLUGINS} lang="ts" />
            </Tab>
            <Tab value="Sessions">
              <DynamicCodeBlock code={USAGE_SESSIONS} lang="ts" />
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
          Extend the agent with plugins
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          <Link
            className="text-fd-foreground underline underline-offset-4"
            href="/docs/packages/harness-plugins"
          >
            <code className="text-sm">ai-sdk-harness-plugins</code>
          </Link>{' '}
          bundles what an agent can be given into plugins, written in code, read from a Claude Code
          plugin directory, or written as JSON, with single items for a marketplace, and applies
          what an agent picks to whichever runtime it drives.
        </p>
        <ShotGrid label="What the plugin does" shots={PLUGIN_SHOTS} />
        <FeatureGrid features={PLUGIN_FEATURES} />
        <div className="mt-8 flex justify-center">
          <Link
            className="inline-flex h-10 items-center gap-2 rounded-full border border-fd-border bg-fd-background px-5 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
            href="/docs/adding-plugins"
          >
            Add plugins to your agent <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-fd-foreground md:text-3xl">
          Run your users&apos; conversations
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          <Link
            className="text-fd-foreground underline underline-offset-4"
            href="/docs/packages/harness-sessions"
          >
            <code className="text-sm">ai-sdk-harness-sessions</code>
          </Link>{' '}
          runs the sessions of a <code className="text-sm">HarnessAgent</code>: several side by side
          in one sandbox, one turn at a time each, suspended when nobody writes to them and resumed
          where they were, across restarts of your server.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
          {SESSION_SHOTS.map((shot) => (
            <Shot key={shot.src} label="What the package does" shot={shot} />
          ))}
        </div>
        <FeatureGrid features={SESSION_FEATURES} />
        <div className="mt-8 flex justify-center">
          <Link
            className="inline-flex h-10 items-center gap-2 rounded-full border border-fd-border bg-fd-background px-5 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
            href="/docs/managing-sessions"
          >
            Manage your agent&apos;s sessions <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-fd-foreground md:text-3xl">
          A chat with Claude Code or Codex, in a sandbox, with plugins
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          The Next.js example: <code className="text-sm">useChat</code> on one side, a{' '}
          <code className="text-sm">HarnessAgent</code> running Claude Code or Codex in a Docker
          Sandbox, or a Cloud Run sandbox, on the other, with the plugins picked for the
          conversation. Every command the agent runs, it runs in the sandbox.
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
        <FeatureGrid className="mt-0" features={FEATURES} />
      </section>
    </main>
  );
}

/** A screenshot of the example, what it shows, and what the package did to get there. */
function Shot({ label, shot: { alt, how, shows, src, title } }: { label: string; shot: Shot }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-fd-border bg-fd-background">
      <Image
        alt={alt}
        className="h-auto w-full border-b border-fd-border"
        height={1000}
        sizes="(max-width: 768px) 100vw, 576px"
        src={src}
        width={1440}
      />
      <figcaption className="space-y-2 p-5 text-sm">
        <h3 className="font-medium text-fd-foreground">{title}</h3>
        <p className="text-fd-muted-foreground">{shows}</p>
        <p className="text-fd-muted-foreground">
          <span className="font-medium text-fd-foreground">{label}: </span>
          {how}
        </p>
      </figcaption>
    </figure>
  );
}

function ShotGrid({ label, shots }: { label: string; shots: Shot[] }) {
  return (
    <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
      {shots.map((shot) => (
        <Shot key={shot.src} label={label} shot={shot} />
      ))}
    </div>
  );
}

function FeatureGrid({
  className = 'mt-8',
  features,
}: {
  className?: string;
  features: Feature[];
}) {
  return (
    <div
      className={`${className} grid grid-cols-1 overflow-hidden rounded-xl border border-fd-border md:grid-cols-3`}
    >
      {features.map(({ icon: Icon, title, description }) => (
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
  );
}
