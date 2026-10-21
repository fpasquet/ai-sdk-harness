import type { PluginIssue, PluginWarning } from 'ai-sdk-harness-plugins';

import {
  defineItem,
  definePlugin,
  InvalidPluginError,
  lintItem,
  lintPlugin,
} from 'ai-sdk-harness-plugins';

import { storedFiles } from '@/lib/plugins';

/**
 * What the check of a plugin, or of an item, written as JSON finds, by field: the mistakes that
 * refuse it, then — once it is accepted — what is likely a mistake all the same.
 */
export interface PluginCheck {
  /** An item when it has a `kind`, a plugin otherwise; `undefined` for what is not JSON. */
  kind: 'item' | 'plugin' | undefined;
  /** Why `definePlugin()` or `defineItem()` refuses it: a back office would not save it. */
  issues: PluginIssue[];
  /** What `lintPlugin()` or `lintItem()` finds in it once accepted: saved, with a warning. */
  warnings: PluginWarning[];
}

/** Checks `text` as `definePlugin()` or `defineItem()` would, then lints what they accept. */
export function checkPluginText(text: string): PluginCheck {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return {
      kind: undefined,
      issues: [{ path: [], message: (error as Error).message }],
      warnings: [],
    };
  }
  const kind =
    typeof config === 'object' && config !== null && 'kind' in config ? 'item' : 'plugin';
  try {
    const warnings =
      kind === 'item' ? lintItem(defineItem(config)) : lintPlugin(definePlugin(config));
    return { kind, issues: [], warnings };
  } catch (error) {
    if (!InvalidPluginError.isInstance(error)) throw error;
    const issues =
      error.issues.length > 0 ? [...error.issues] : [{ path: [], message: error.message }];
    return { kind, issues, warnings: [] };
  }
}

/** A plugin or an item to start from, in the page's picker. */
export interface PluginSample {
  label: string;
  text: string;
}

/** Written with mistakes, one of each kind the check finds. */
const FAULTY: Record<string, unknown> = {
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
  'A command whose prompt reads more than its hint announces (warning)': {
    kind: 'command',
    name: 'pay',
    description: 'Pay an invoice',
    argumentHint: '<invoice>',
    prompt: 'Pay the invoice $1 with the card $2, then say what was paid.',
  },
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
};

/** The plugins and items of the marketplace as their files hold them, then the faulty ones. */
export async function pluginSamples(): Promise<PluginSample[]> {
  const files = [...(await storedFiles('plugins')), ...(await storedFiles('items'))];
  return [
    ...Object.entries(FAULTY).map(([label, json]) => ({
      label,
      text: `${JSON.stringify(json, null, 2)}\n`,
    })),
    ...files.map(({ path, text }) => ({ label: `marketplace/${path}`, text })),
  ];
}
