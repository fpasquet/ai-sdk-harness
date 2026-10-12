'use client';

import type { CatalogDescription, CatalogItemDescription } from 'ai-sdk-harness-plugins';

import { CheckIcon, PuzzleIcon } from 'lucide-react';

import type { HarnessId } from '@/lib/harnesses';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type PluginDescription = CatalogDescription['plugins'][number];

/** What the conversation can be given: every plugin, and every item on its own. */
export const everything = ({ items, plugins }: CatalogDescription): string[] => [
  ...plugins.map(({ id }) => id),
  ...items.filter(({ plugin }) => plugin === undefined).map(({ id }) => id),
];

/**
 * The ids `selection` comes to, the way the server's catalog expands it: a plugin brings its
 * items, an item what it requires.
 */
export function expandSelection(
  { items }: CatalogDescription,
  selection: readonly string[],
): Set<string> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const wanted = new Set<string>();
  const queue = [...selection];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (wanted.has(id)) continue;
    wanted.add(id);
    const plugin = id.startsWith('plugin:') ? id.slice('plugin:'.length) : undefined;
    if (plugin !== undefined) {
      queue.push(...items.filter((item) => item.plugin === plugin).map((item) => item.id));
    }
    queue.push(...(byId.get(id)?.requires ?? []));
  }
  return wanted;
}

/** What a plugin brings, in a few words: `2 commands · 1 skill · 1 hook`. */
function contentsOf(plugin: PluginDescription): string {
  const counts: [number, string][] = [
    [plugin.tools.length, 'tool'],
    [plugin.commands.length, 'command'],
    [plugin.skills.length, 'skill'],
    [plugin.rules.length, 'rule'],
    [plugin.hooks.length, 'hook'],
    [plugin.subagents.length, 'subagent'],
    [plugin.mcpServers.length, 'MCP server'],
  ];
  return counts
    .filter(([count]) => count > 0)
    .map(([count, kind]) => `${count} ${kind}${count > 1 ? 's' : ''}`)
    .join(' · ');
}

/** What the runtime of the conversation cannot take of a plugin, or of an item. */
function leftOut(harness: HarnessId, plugin?: PluginDescription, item?: CatalogItemDescription) {
  const features =
    plugin?.unsupported[harness] ?? (item?.unsupportedOn.includes(harness) ? [item.kind] : []);
  return features.length > 0 ? `Left out on this agent: ${features.join(', ')}` : undefined;
}

function Card({
  details,
  label,
  note,
  on,
  onToggle,
  title,
}: {
  details: string;
  label?: string;
  note?: string;
  on: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <button
      aria-pressed={on}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent',
        on ? 'border-primary/40 bg-accent/40' : 'opacity-70',
      )}
      onClick={onToggle}
      type="button"
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border',
          on && 'border-primary bg-primary text-primary-foreground',
        )}
      >
        {on && <CheckIcon className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {label && (
            <span className="rounded-sm bg-muted px-1 text-[10px] tracking-wide text-muted-foreground uppercase">
              {label}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{details}</span>
        {note && <span className="text-xs text-amber-600 dark:text-amber-400">{note}</span>}
      </span>
    </button>
  );
}

/**
 * What the conversation picks in the marketplace, before its first message: plugins, and items
 * on their own. "New chat" brings it back.
 */
export function MarketplacePicker({
  harness,
  marketplace,
  onChange,
  selection,
}: {
  harness: HarnessId;
  marketplace: CatalogDescription;
  onChange: (selection: string[]) => void;
  selection: string[];
}) {
  const order = everything(marketplace);
  const toggle = (id: string) =>
    onChange(order.filter((other) => (other === id) !== selection.includes(other)));
  const single = marketplace.items.filter(({ plugin }) => plugin === undefined);

  return (
    <section aria-label="Marketplace" className="w-full max-w-3xl space-y-4 text-left">
      <div>
        <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <PuzzleIcon className="size-3.5" /> Plugins
        </h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {marketplace.plugins.map((plugin) => (
            <Card
              details={`${plugin.description} ${contentsOf(plugin)}`}
              key={plugin.id}
              note={leftOut(harness, plugin)}
              on={selection.includes(plugin.id)}
              onToggle={() => toggle(plugin.id)}
              title={plugin.name}
            />
          ))}
        </div>
      </div>
      <div>
        <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <PuzzleIcon className="size-3.5" /> Items on their own
        </h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {single.map((item) => (
            <Card
              details={
                item.requires.length > 0
                  ? `${item.description} Needs ${item.requires.join(', ')}.`
                  : item.description
              }
              key={item.id}
              label={item.kind}
              note={leftOut(harness, undefined, item)}
              on={selection.includes(item.id)}
              onToggle={() => toggle(item.id)}
              title={item.invocation ?? item.name}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** How many plugins and items the conversation picked, in the header. */
export function SelectionCount({ count }: { count: number }) {
  return (
    <Badge className="gap-1" variant="secondary">
      <PuzzleIcon className="size-3" /> {count} picked
    </Badge>
  );
}
