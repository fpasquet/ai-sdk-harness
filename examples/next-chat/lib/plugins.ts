import type { Catalog, CatalogDescription, Plugin } from 'ai-sdk-harness-plugins';

import { tool } from 'ai';
import { createCatalog, definePlugin, loadClaudeCodePlugin } from 'ai-sdk-harness-plugins';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Refuses, before Claude Code runs it, a shell command that would wipe the sandbox, rewrite history
 * or install a package globally: a `PreToolUse` hook gets the call as JSON on its standard input,
 * and exit status 2 blocks it, its standard error handed to the agent, which then does it another
 * way.
 */
const GUARD = `#!/bin/sh
input=$(cat)
if printf '%s' "$input" | grep -Eq 'npm (install|i|add) [^"]*(-g|--global)( |"|$)'; then
  echo 'Blocked by the safety-guard plugin: no global installs in this sandbox. Run the package with npx instead, or install it in the project.' >&2
  exit 2
fi
if printf '%s' "$input" | grep -Eq 'rm -rf (/|~|\\$HOME)([" ]|$)|git push (-f|--force)|mkfs|:\\(\\)\\{'; then
  echo 'Blocked by the safety-guard plugin: this command could destroy the sandbox or the history. Do it another way, or ask the user.' >&2
  exit 2
fi
`;

const safetyGuard = definePlugin({
  name: 'safety-guard',
  description:
    'Blocks the shell commands that would install packages globally, wipe the sandbox or force-push.',
  hooks: [
    {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: '"${PLUGIN_ROOT}/guard.sh"',
      timeout: 10,
      description:
        'Before each shell command: refuses `npm install -g`, `rm -rf /`, `git push --force`, `mkfs`…',
    },
  ],
  files: [{ path: 'guard.sh', content: GUARD, executable: true }],
});

const codeTour = definePlugin({
  name: 'code-tour',
  description: 'Slash commands to explain code, and a skill on how to explain it well.',
  commands: [
    {
      name: 'explain',
      description: 'Explain a file or a directory of the sandbox',
      argumentHint: '<path>',
      prompt:
        'Explain $1 to a developer who has never seen it, following the code-tour skill. ' +
        'Read it first; if it does not exist, say so and list what is there instead.',
    },
    {
      name: 'tour',
      description: 'Give a tour of the working directory',
      prompt: 'Give me a short tour of the working directory, following the code-tour skill.',
    },
  ],
  skills: [
    {
      name: 'code-tour',
      description: 'How to explain code to a newcomer. Use it whenever you explain or tour code.',
      content: [
        '# Explaining code',
        '',
        '1. Start with what the code is for, in one sentence.',
        '2. Name the two or three pieces that matter, and how they call each other.',
        '3. Show one short excerpt, the most telling one, never a whole file.',
        '4. End with where to look next.',
      ].join('\n'),
    },
  ],
});

const sandboxInspector = definePlugin({
  name: 'sandbox-inspector',
  description: 'A tool that runs on your server and reaches into the sandbox, and a subagent.',
  tools: {
    inspectSandbox: tool({
      description:
        'Describe the sandbox you run in: operating system, CPU, memory, disk, Node.js and git. ' +
        'Call it when asked about the machine or the environment.',
      inputSchema: z.object({}),
      // Runs here, on the server: the harness hands the tool the session's sandbox to work in.
      execute: async (_input, { experimental_sandbox: sandbox }) => {
        if (sandbox === undefined) return { error: 'No sandbox.' };
        const { stdout } = await sandbox.run({
          command: [
            'uname -srm',
            'nproc',
            `free -h | awk '/^Mem:/ { print $2 " total, " $7 " available" }'`,
            `df -h . | awk 'NR == 2 { print $2 " total, " $4 " free" }'`,
            'node --version',
            'git --version',
          ].join('; '),
        });
        const [system, cpus, memory, disk, node, git] = stdout.trim().split('\n');
        return { system, cpus, memory, disk, node, git };
      },
    }),
  },
  subagents: [
    {
      name: 'test-writer',
      description: 'Writes and runs tests for code the main agent wrote. Delegate testing to it.',
      instructions:
        'You write focused tests for the code you are pointed at, with the test runner the ' +
        'project already uses (node:test when there is none), run them, and report what passed.',
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
  ],
});

/** The JSON files of a directory of `marketplace/`: configuration, wherever it is kept. */
async function stored(directory: 'items' | 'plugins'): Promise<unknown[]> {
  const root = join(process.cwd(), 'marketplace', directory);
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(root, name), 'utf8')) as unknown),
  );
}

interface ExampleState {
  catalog?: Promise<Catalog>;
  /** The plugins of each selection resolved so far, by fingerprint: their MCP clients stay open. */
  resolved: Map<string, Promise<Plugin[]>>;
}

// Kept on globalThis so `next dev` reloading this module does not read the marketplace again, nor
// open the MCP clients twice: they live as long as the server.
const globals = globalThis as { __aiSdkMarketplaceExample?: ExampleState };
const state: ExampleState = (globals.__aiSdkMarketplaceExample ??= { resolved: new Map() });

/**
 * The marketplace of the example: plugins and items, configuration all of them, written in code
 * (`safety-guard`, `code-tour`, `sandbox-inspector`), read from a Claude Code plugin directory
 * (`plugins/commit-helper`), or from JSON files (`marketplace/`: the `library-docs` plugin, and
 * items on their own).
 */
export function marketplace(): Promise<Catalog> {
  state.catalog ??= Promise.all([
    loadClaudeCodePlugin(join(process.cwd(), 'plugins/commit-helper')),
    stored('plugins'),
    stored('items'),
  ]).then(([commitHelper, configured, items]) =>
    createCatalog({
      plugins: [safetyGuard, codeTour, sandboxInspector, commitHelper, ...configured],
      items,
    }),
  );
  return state.catalog;
}

/** What the page shows of the marketplace: its documentation, never its code. */
export async function describeMarketplace(): Promise<CatalogDescription> {
  return (await marketplace()).describe();
}

/**
 * The plugins `selection` (catalog ids) resolves to, and its fingerprint: the same selection, and
 * the same stored data, give the same plugins, their MCP clients opened once. Throws
 * `InvalidPluginError` for an id the marketplace does not have.
 */
export async function resolveSelection(
  selection: unknown,
): Promise<{ fingerprint: string; plugins: Plugin[] }> {
  const ids = Array.isArray(selection) ? selection.filter((id) => typeof id === 'string') : [];
  const catalog = await marketplace();
  const fingerprint = catalog.fingerprint(ids);
  let plugins = state.resolved.get(fingerprint);
  if (plugins === undefined) {
    plugins = catalog.resolve(ids).then((resolved) => resolved.plugins);
    state.resolved.set(fingerprint, plugins);
    // A failed resolution is not remembered: the next message tries again.
    plugins.catch(() => state.resolved.delete(fingerprint));
  }
  return { fingerprint, plugins: await plugins };
}
