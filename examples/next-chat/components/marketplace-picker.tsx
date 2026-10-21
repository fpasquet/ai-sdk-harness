'use client';

import type { CatalogDescription, CatalogItemDescription } from 'ai-sdk-harness-plugins';
import type { ReactNode } from 'react';

import { deselect, explain } from 'ai-sdk-harness-plugins/selection';
import { CheckIcon, InfoIcon, LockIcon, PuzzleIcon } from 'lucide-react';

import type { HarnessId } from '@/lib/harnesses';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type PluginDescription = CatalogDescription['plugins'][number];

/** What the conversation can be given: every plugin, and every item on its own. */
export const everything = ({ items, plugins }: CatalogDescription): string[] => [
  ...plugins.map(({ id }) => id),
  ...items.filter(({ plugin }) => plugin === undefined).map(({ id }) => id),
];

/** What a card calls `id`: a plugin by its name, an item of a plugin by its plugin. */
function nameOf({ items, plugins }: CatalogDescription, id: string): string {
  const plugin = plugins.find((entry) => entry.id === id);
  if (plugin !== undefined) return plugin.name;
  const item = items.find((entry) => entry.id === id);
  return item === undefined ? id : (item.plugin ?? item.invocation ?? item.name);
}

/** What keeps an id selected, each named once: `Required by upgrades, /npm`. */
function requiredByOf(marketplace: CatalogDescription, requiredBy: readonly string[]) {
  const names = [...new Set(requiredBy.map((id) => nameOf(marketplace, id)))];
  return names.length > 0 ? `Required by ${names.join(', ')}` : undefined;
}

/**
 * What a plugin brings, in a few words, and what it needs besides its items:
 * `2 commands · 1 skill · needs tool:npm-latest`.
 */
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
  return [
    ...counts
      .filter(([count]) => count > 0)
      .map(([count, kind]) => `${count} ${kind}${count > 1 ? 's' : ''}`),
    ...(plugin.requires ? [`needs ${plugin.requires.join(', ')}`] : []),
  ].join(' · ');
}

/** What the runtime of the conversation cannot take of a plugin, or of an item. */
function leftOut(harness: HarnessId, plugin?: PluginDescription, item?: CatalogItemDescription) {
  const features =
    plugin?.unsupported[harness] ?? (item?.unsupportedOn.includes(harness) ? [item.kind] : []);
  return features.length > 0 ? `Left out on this agent: ${features.join(', ')}` : undefined;
}

function KindLabel({ kind }: { kind: string }) {
  return (
    <span className="rounded-sm bg-muted px-1 text-[10px] tracking-wide text-muted-foreground uppercase">
      {kind}
    </span>
  );
}

function Card({
  action,
  details,
  label,
  note,
  on,
  onToggle,
  requiredBy,
  title,
}: {
  /** Beside the card, not in it: a card is a toggle. */
  action?: ReactNode;
  details: string;
  label?: string;
  note?: string;
  on: boolean;
  onToggle: () => void;
  /** What keeps it selected: the card is locked while anything does. */
  requiredBy?: string;
  title: string;
}) {
  return (
    <div className="relative">
      <button
        aria-pressed={on}
        className={cn(
          'flex size-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
          on ? 'border-primary/40 bg-accent/40' : 'opacity-70',
          requiredBy === undefined ? 'hover:bg-accent' : 'cursor-not-allowed',
          action !== undefined && 'pr-10',
        )}
        disabled={requiredBy !== undefined}
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
            {label && <KindLabel kind={label} />}
          </span>
          <span className="text-xs text-muted-foreground">{details}</span>
          {requiredBy && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <LockIcon className="size-3" /> {requiredBy}
            </span>
          )}
          {note && <span className="text-xs text-amber-600 dark:text-amber-400">{note}</span>}
        </span>
      </button>
      {action && <div className="absolute top-2 right-2">{action}</div>}
    </div>
  );
}

/** One plugin or item in the details of a plugin. */
function DetailRow({
  description,
  kind,
  notes,
  title,
}: {
  description: string;
  kind: string;
  notes: (string | undefined)[];
  title: string;
}) {
  return (
    <li className="flex flex-col gap-0.5 rounded-md border p-2.5">
      <span className="flex items-center gap-2 text-sm font-medium">
        {title}
        <KindLabel kind={kind} />
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
      {notes
        .filter((note) => note !== undefined)
        .map((note) => (
          <span className="text-xs text-muted-foreground/80" key={note}>
            {note}
          </span>
        ))}
    </li>
  );
}

/**
 * Everything selecting `plugin` brings, as `explain()` reads it from the marketplace's
 * description: its own items, then the items it is linked to — what it requires, and what that
 * requires in turn —, each with what brings it.
 */
function PluginDetails({
  harness,
  marketplace,
  plugin,
}: {
  harness: HarnessId;
  marketplace: CatalogDescription;
  plugin: PluginDescription;
}) {
  const own = marketplace.items.filter((item) => item.plugin === plugin.name);
  const broughtBy = new Map(
    explain(marketplace, [plugin.id]).map(({ id, requiredBy }) => [id, requiredBy]),
  );
  const linked = [...marketplace.plugins, ...marketplace.items].filter(
    (entry) =>
      entry.id !== plugin.id &&
      broughtBy.has(entry.id) &&
      !('kind' in entry && entry.plugin === plugin.name),
  );
  const why = (id: string): string => {
    const by = broughtBy.get(id) ?? [];
    if (by.includes(plugin.id)) return `Required by ${plugin.name}.`;
    const carrier = by.find((other) => other.startsWith('plugin:'));
    if (carrier !== undefined) return `Comes with ${nameOf(marketplace, carrier)}.`;
    return `${requiredByOf(marketplace, by)}.`;
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button aria-label={`What ${plugin.name} holds`} size="icon-xs" variant="ghost">
          <InfoIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{plugin.name}</DialogTitle>
          <DialogDescription>{plugin.description}</DialogDescription>
        </DialogHeader>
        <section className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            In the plugin · written with it
          </h4>
          <ul className="space-y-2">
            {own.map((item) => (
              <DetailRow
                description={item.description}
                key={item.id}
                kind={item.kind}
                notes={[
                  item.requires.length > 0 ? `Needs ${item.requires.join(', ')}.` : undefined,
                  leftOut(harness, undefined, item),
                ]}
                title={item.invocation ?? item.name}
              />
            ))}
          </ul>
        </section>
        {linked.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              Linked · delivered as published, never copied into the plugin
            </h4>
            <ul className="space-y-2">
              {linked.map((entry) =>
                'kind' in entry ? (
                  <DetailRow
                    description={entry.description}
                    key={entry.id}
                    kind={entry.kind}
                    notes={[
                      `${entry.plugin === undefined ? 'On its own' : `From ${entry.plugin}`}. ${why(entry.id)}`,
                      leftOut(harness, undefined, entry),
                    ]}
                    title={entry.invocation ?? entry.name}
                  />
                ) : (
                  <DetailRow
                    description={entry.description}
                    key={entry.id}
                    kind="plugin"
                    notes={[why(entry.id), leftOut(harness, entry)]}
                    title={entry.name}
                  />
                ),
              )}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the conversation picks in the marketplace, before its first message: plugins, and items
 * on their own. A card is on for what the pick comes to — `explain()`, from the description the
 * server's catalog gave —, and locked, with what requires it, while anything does. "New chat"
 * brings it back.
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
  const picked = new Map(
    explain(marketplace, selection, { ignoreUnknown: true }).map(({ id, requiredBy }) => [
      id,
      requiredByOf(marketplace, requiredBy),
    ]),
  );
  const toggle = (id: string) => {
    if (!picked.has(id)) {
      onChange(order.filter((other) => other === id || selection.includes(other)));
      return;
    }
    const { requiredBy, selection: next } = deselect(marketplace, selection, id);
    // A card locked: what still brings it keeps it in.
    if (requiredBy.length === 0) onChange(next);
  };
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
              action={<PluginDetails harness={harness} marketplace={marketplace} plugin={plugin} />}
              details={`${plugin.description} ${contentsOf(plugin)}`}
              key={plugin.id}
              note={leftOut(harness, plugin)}
              on={picked.has(plugin.id)}
              onToggle={() => toggle(plugin.id)}
              requiredBy={picked.get(plugin.id)}
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
              on={picked.has(item.id)}
              onToggle={() => toggle(item.id)}
              requiredBy={picked.get(item.id)}
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
