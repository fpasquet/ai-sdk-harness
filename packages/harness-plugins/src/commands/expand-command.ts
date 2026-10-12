import type { Plugin } from '../definitions/plugin.js';

/**
 * What a user can call by name at the start of a message: a command of a plugin, or one of its
 * skills — as in Claude Code, where `/<skill>` asks the agent to use it.
 */
export interface SlashCommand {
  kind: 'command' | 'skill';
  /** The plugin it belongs to. */
  plugin: string;
  name: string;
  /** What the user types: `/<name>`, or `/<plugin>:<name>` when two share the name. */
  invocation: string;
  description: string;
  argumentHint?: string;
}

/** A message that called a command or a skill of the plugins, and the prompt it stands for. */
export interface ExpandedCommand {
  kind: 'command' | 'skill';
  /** The plugin the command or skill belongs to. */
  plugin: string;
  name: string;
  /** Everything after the name, trimmed. */
  arguments: string;
  /** What to send the agent instead of the message. */
  prompt: string;
}

/**
 * What {@link listSlashCommands} reads of a plugin: a {@link Plugin}, or its public
 * `PluginDescription`, so a client lists the same names as your server expands.
 */
export interface SlashCommandSource {
  name: string;
  commands?: readonly { name: string; description: string; argumentHint?: string }[];
  skills?: readonly { name: string; description: string }[];
}

/** `/<name>`, then its arguments: everything after the first blank. */
const INVOCATION = /^\/([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)(?:\s+([\s\S]*))?$/;

/**
 * The prompt `text` stands for when it opens with `/<name> <arguments>` — `/<plugin>:<name>` when
 * two share the name — and names a command or a skill of `plugins`:
 *
 * - a **command** is expanded the way Claude Code expands its own: `$ARGUMENTS` is everything after
 *   the name, `$1` to `$9` each argument, a quoted one kept whole; a prompt that uses neither gets
 *   the arguments appended;
 * - a **skill** becomes a request to use it, the arguments after it.
 *
 * A command wins over a skill of the same name. `undefined` when `text` calls neither: send it to
 * the agent as it is. Expanding on your server keeps it the same for every runtime, and lets the
 * conversation show the message as the user wrote it.
 */
export function expandCommand(
  text: string,
  plugins: readonly Plugin[],
): ExpandedCommand | undefined {
  const match = INVOCATION.exec(text.trim());
  if (match === null) return undefined;
  const name = match[1] ?? '';
  const found = listSlashCommands(plugins).find(
    (entry) => entry.invocation === `/${name}` || `${entry.plugin}:${entry.name}` === name,
  );
  if (found === undefined) return undefined;
  const raw = (match[2] ?? '').trim();
  const prompt =
    found.kind === 'skill'
      ? `Use the "${found.name}" skill.${raw === '' ? '' : `\n\n${raw}`}`
      : render(promptOf(plugins, found), raw);
  return { kind: found.kind, plugin: found.plugin, name: found.name, arguments: raw, prompt };
}

/**
 * Every command, then every skill, of `plugins` — or of their public descriptions —, with the name
 * a user calls it by: what a prompt offers as the user types `/`.
 */
export function listSlashCommands(plugins: readonly SlashCommandSource[]): SlashCommand[] {
  const all = [
    ...plugins.flatMap((plugin) =>
      (plugin.commands ?? []).map(({ name, description, argumentHint }) => ({
        kind: 'command' as const,
        plugin: plugin.name,
        name,
        description,
        ...(argumentHint !== undefined && { argumentHint }),
      })),
    ),
    ...plugins.flatMap((plugin) =>
      (plugin.skills ?? []).map(({ name, description }) => ({
        kind: 'skill' as const,
        plugin: plugin.name,
        name,
        description,
      })),
    ),
  ];
  return all.map((entry) => {
    const shared = all.filter((other) => other.name === entry.name).length > 1;
    return { ...entry, invocation: `/${shared ? `${entry.plugin}:` : ''}${entry.name}` };
  });
}

function promptOf(plugins: readonly Plugin[], { plugin, name }: SlashCommand): string {
  const owner = plugins.find((candidate) => candidate.name === plugin);
  return owner?.commands?.find((command) => command.name === name)?.prompt ?? '';
}

function render(prompt: string, raw: string): string {
  const positional = [...raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    ([, double, single, bare]) => double ?? single ?? bare ?? '',
  );
  const uses = /\$ARGUMENTS|\$[1-9]/.test(prompt);
  const expanded = prompt
    .replaceAll('$ARGUMENTS', raw)
    .replace(/\$([1-9])/g, (_, index: string) => positional[Number(index) - 1] ?? '');
  return uses || raw === '' ? expanded : `${expanded}\n\nARGUMENTS: ${raw}`;
}
