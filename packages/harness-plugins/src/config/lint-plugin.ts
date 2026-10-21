import type { Plugin, PluginCommand, PluginFile, ToolDefinition } from '../definitions/plugin.js';
import type { Item } from './item-schema.js';

import { citedArguments, hintedArguments } from '../commands/command-arguments.js';
import { inputPropertiesOf } from './input-schema.js';
import { citedInputVariables, inputVariable } from './input-variables.js';
import { pluginOfItem } from './item-schema.js';
import { isToolDefinition } from './plugin-schema.js';

/**
 * What a warning is about:
 *
 * - `unread-input`: a property of a `sandbox-command`'s input that neither the command nor a file
 *   of the plugin it names reads — the model fills it for nothing;
 * - `argument-beyond-hint`: a `$<n>` past the arguments the hint announces;
 * - `unread-argument`: an argument the hint announces, that the prompt never reads;
 * - `appended-arguments`: a hint, and a prompt that reads no argument: they are appended to it.
 */
export type PluginWarningCode =
  'appended-arguments' | 'argument-beyond-hint' | 'unread-argument' | 'unread-input';

/** Something that works but is likely a mistake, at `path` within the plugin or the item. */
export interface PluginWarning {
  path: (number | string)[];
  code: PluginWarningCode;
  message: string;
}

/**
 * What is likely a mistake in a plugin `definePlugin` accepts: a parameter nothing reads, the
 * arguments of a command its hint does not announce. It never throws: what a loader logs, or a
 * form shows next to each field.
 */
export function lintPlugin(plugin: Plugin): PluginWarning[] {
  const tools = Object.entries(plugin.tools ?? {}).flatMap(([name, tool]) =>
    isToolDefinition(tool) && tool.type === 'sandbox-command'
      ? unreadInputs(tool, plugin.files ?? []).map(at('tools', name))
      : [],
  );
  const commands = (plugin.commands ?? []).flatMap((command, index) =>
    argumentWarnings(command).map(at('commands', index)),
  );
  return [...tools, ...commands];
}

/** What {@link lintPlugin} finds in an item on its own, at paths within the item. */
export function lintItem(item: Item): PluginWarning[] {
  // Within the plugin, under `tools.<name>` or `commands.0`.
  return lintPlugin(pluginOfItem(item)).map((warning) => ({
    ...warning,
    path: warning.path.slice(2),
  }));
}

const at =
  (...prefix: (number | string)[]) =>
  (warning: PluginWarning): PluginWarning => ({ ...warning, path: [...prefix, ...warning.path] });

/** The properties of a `sandbox-command`'s input that neither it nor a file it names reads. */
function unreadInputs(
  tool: Extract<ToolDefinition, { type: 'sandbox-command' }>,
  files: readonly PluginFile[],
): PluginWarning[] {
  const input = inputPropertiesOf(tool.inputSchema);
  if (input === undefined) return [];
  const named = files.filter(({ path }) => tool.command.includes(path));
  const cited = [tool.command, ...named.map(({ content }) => content)].map(citedInputVariables);
  if (cited.some(({ all }) => all)) return [];
  const read = new Set(cited.flatMap(({ names }) => names));
  return input.properties
    .filter((key) => !read.has(inputVariable(key)))
    .map((key) => ({
      path: ['inputSchema', 'properties', key],
      code: 'unread-input',
      message: `is never read: neither the command nor a file it names reads $${inputVariable(key)} or $INPUT`,
    }));
}

/** Where the prompt of `command` and its hint disagree on its arguments. */
function argumentWarnings({ argumentHint, prompt }: PluginCommand): PluginWarning[] {
  if (argumentHint === undefined || argumentHint.trim() === '') return [];
  const { all, positions } = citedArguments(prompt);
  if (!all && positions.length === 0) {
    return [
      {
        path: ['prompt'],
        code: 'appended-arguments',
        message:
          'reads neither $ARGUMENTS nor $1 to $9: the arguments the hint announces are appended to it',
      },
    ];
  }
  const hinted = hintedArguments(argumentHint);
  // `$ARGUMENTS` reads them all, a hint of free text cannot be counted.
  if (all || hinted === undefined) return [];
  const beyond: PluginWarning[] = positions
    .filter((position) => position > hinted)
    .map((position) => ({
      path: ['prompt'],
      code: 'argument-beyond-hint',
      message: `reads $${position}, but the hint announces ${hinted} argument${hinted === 1 ? '' : 's'}`,
    }));
  // One the prompt never reads, `expandCommand` drops.
  const unread =
    hinted === Infinity
      ? []
      : Array.from({ length: Math.min(hinted, 9) }, (_, index) => index + 1).filter(
          (position) => !positions.includes(position),
        );
  if (unread.length === 0) return beyond;
  return [
    ...beyond,
    {
      path: ['argumentHint'],
      code: 'unread-argument',
      message: `announces ${unread.map((position) => `$${position}`).join(', ')}, which the prompt never reads: dropped`,
    },
  ];
}
