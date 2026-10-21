import type { PluginIssue, PluginWarning } from 'ai-sdk-harness-plugins';

import {
  defineItem,
  definePlugin,
  InvalidPluginError,
  lintItem,
  lintPlugin,
} from 'ai-sdk-harness-plugins';

import { storedFiles } from '@/lib/plugins';

/** What a page checks: a whole plugin, or an item on its own. */
export type CheckKind = 'item' | 'plugin';

/** Whether `value` names a {@link CheckKind}. */
export const isCheckKind = (value: unknown): value is CheckKind =>
  value === 'item' || value === 'plugin';

/**
 * What the check of a plugin, or of an item, written as JSON finds, by field: the mistakes that
 * refuse it, then — once it is accepted — what is likely a mistake all the same.
 */
export interface PluginCheck {
  /** Whether the text is JSON: when it is not, the one issue says why. */
  json: boolean;
  /** Why `definePlugin()` or `defineItem()` refuses it: a back office would not save it. */
  issues: PluginIssue[];
  /** What `lintPlugin()` or `lintItem()` finds in it once accepted: saved, with a warning. */
  warnings: PluginWarning[];
}

/**
 * Checks `text` as `definePlugin()` — or `defineItem()`, for an item — would, then lints what it
 * accepts with `lintPlugin()` or `lintItem()`.
 */
export function checkText(text: string, kind: CheckKind): PluginCheck {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return { json: false, issues: [{ path: [], message: (error as Error).message }], warnings: [] };
  }
  try {
    const warnings =
      kind === 'item' ? lintItem(defineItem(config)) : lintPlugin(definePlugin(config));
    return { json: true, issues: [], warnings };
  } catch (error) {
    if (!InvalidPluginError.isInstance(error)) throw error;
    const issues =
      error.issues.length > 0 ? [...error.issues] : [{ path: [], message: error.message }];
    return { json: true, issues, warnings: [] };
  }
}

/** A plugin or an item to start from, in the page's picker. */
export interface PluginSample {
  label: string;
  text: string;
}

/** Items written with mistakes: refused by `defineItem()`, or accepted with warnings. */
const FAULTY_ITEMS: Record<string, unknown> = {
  'A sandbox-command that reads what it does not declare (refused)': {
    kind: 'tool',
    name: 'run-tests',
    type: 'sandbox-command',
    description: 'Run the tests of a service of the monorepo.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Only the tests whose name matches' } },
      required: ['service'],
    },
    command: 'cd "services/$INPUT_SERVICE" && npm test -- "$INPUT_PATERN"',
  },
  'An http tool whose url takes what its schema does not declare (refused)': {
    kind: 'tool',
    name: 'github-issue',
    type: 'http',
    description: 'Read an issue of a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/name' } },
      required: ['repo', 'number'],
    },
    url: 'https://api.github.com/repos/{repo}/issues/{number}',
  },
  'A sandbox-command with a property it never reads (warning)': {
    kind: 'tool',
    name: 'disk-usage',
    type: 'sandbox-command',
    description: 'How much disk a directory of the sandbox takes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The directory: the working directory when absent' },
        human: { type: 'boolean', description: 'In K, M or G rather than in blocks' },
      },
    },
    command: 'du -s "${INPUT_PATH:-.}"',
  },
  'A command whose prompt reads more than its hint announces (warning)': {
    kind: 'command',
    name: 'pay',
    description: 'Pay an invoice',
    argumentHint: '<invoice>',
    prompt: 'Pay the invoice $1 with the card $2, then say what was paid.',
  },
};

/** Plugins written with mistakes: accepted with warnings by `lintPlugin()`, or refused. */
const FAULTY_PLUGINS: Record<string, unknown> = {
  'A plugin with a parameter and arguments nothing reads (warnings)': {
    name: 'release-kit',
    description: 'Release helpers.',
    tools: {
      changelog: {
        type: 'sandbox-command',
        description: 'The commits of a range, one line each.',
        inputSchema: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from'],
        },
        command: 'git log --oneline "$INPUT_FROM..HEAD"',
      },
    },
    commands: [
      {
        name: 'release',
        description: 'Prepare a release',
        argumentHint: '<version> [notes]',
        prompt: 'Prepare release $1: read the changes since the last tag and draft the notes.',
      },
      {
        name: 'announce',
        description: 'Announce the last release',
        argumentHint: '<channel>',
        prompt: 'Write the announcement of the last release.',
      },
    ],
  },
  'A plugin whose sandbox-command runs a script of its files (refused)': {
    name: 'lint-kit',
    description: 'Lint a file with the project’s ESLint.',
    tools: {
      lint: {
        type: 'sandbox-command',
        description: 'Lint a file, and list what ESLint finds.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        command: '"${PLUGIN_ROOT}/lint.sh" "$INPUT_PATH"',
      },
    },
    files: [{ path: 'lint.sh', content: '#!/bin/sh\nnpx eslint "$1"\n', executable: true }],
  },
};

/**
 * What a page of `kind` starts from: the samples written with mistakes, then the plugins — or the
 * items — of the marketplace as their files hold them.
 */
export async function checkSamples(kind: CheckKind): Promise<PluginSample[]> {
  const faulty = kind === 'item' ? FAULTY_ITEMS : FAULTY_PLUGINS;
  const files = await storedFiles(kind === 'item' ? 'items' : 'plugins');
  return [
    ...Object.entries(faulty).map(([label, json]) => ({
      label,
      text: `${JSON.stringify(json, null, 2)}\n`,
    })),
    ...files.map(({ path, text }) => ({ label: `marketplace/${path}`, text })),
  ];
}
