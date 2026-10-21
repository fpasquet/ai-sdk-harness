'use client';

import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CircleXIcon,
  FileCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { PluginCheck, PluginSample } from '@/lib/plugin-check';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** How long the text must stay unchanged before it is checked again. */
const DEBOUNCE_MS = 300;

/**
 * A plugin, or an item, as JSON, checked by the server as you type: the mistakes that refuse it,
 * then what is likely a mistake in what is accepted, each at its field. What a back office that
 * edits a marketplace shows next to its form.
 */
export function PluginChecker({ samples }: { samples: PluginSample[] }) {
  const [label, setLabel] = useState(samples[0]?.label ?? '');
  const [text, setText] = useState(samples[0]?.text ?? '');
  const [check, setCheck] = useState<PluginCheck>();

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch('/api/plugin-check', { method: 'POST', body: text, signal: controller.signal })
        .then((response) => response.json() as Promise<PluginCheck>)
        .then(setCheck)
        .catch(() => {
          // A newer text took over: its check follows.
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  const pick = (next: string) => {
    setLabel(next);
    setText(samples.find((sample) => sample.label === next)?.text ?? '');
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <FileCheckIcon className="size-5 shrink-0 text-muted-foreground" />
          <h1 className="truncate font-semibold">Check a plugin</h1>
          <Badge className="hidden sm:inline-flex" variant="secondary">
            ai-sdk-harness-plugins
          </Badge>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/">
            <ArrowLeftIcon /> Back to the chat
          </Link>
        </Button>
      </header>
      <main className="grid min-h-0 flex-1 gap-4 p-4 md:grid-cols-2">
        <section className="flex min-h-0 flex-col gap-3">
          <Select onValueChange={pick} value={label}>
            <SelectTrigger aria-label="Start from" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {samples.map((sample) => (
                <SelectItem key={sample.label} value={sample.label}>
                  {sample.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            aria-label="The plugin or the item, as JSON"
            className="field-sizing-fixed min-h-64 flex-1 resize-none font-mono text-xs"
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            value={text}
          />
          <p className="text-xs text-muted-foreground">
            With a <code>kind</code>, an item, checked by <code>defineItem()</code> then{' '}
            <code>lintItem()</code>; without, a plugin, by <code>definePlugin()</code> then{' '}
            <code>lintPlugin()</code>. Nothing is saved, nothing is run.
          </p>
        </section>
        <section aria-live="polite" className="min-h-0 overflow-y-auto">
          {check && <CheckResult check={check} />}
        </section>
      </main>
    </div>
  );
}

/** What the check says of the plugin or the item: refused, accepted with warnings, or clean. */
function CheckResult({ check }: { check: PluginCheck }) {
  const name = check.kind === 'item' ? 'item' : 'plugin';
  const Name = check.kind === 'item' ? 'Item' : 'Plugin';
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (check.kind === undefined) {
    return (
      <Findings
        icon={<CircleXIcon className="size-4 text-destructive" />}
        rows={check.issues}
        title="Not JSON"
      />
    );
  }
  if (check.issues.length > 0) {
    return (
      <Findings
        icon={<CircleXIcon className="size-4 text-destructive" />}
        rows={check.issues}
        subtitle={`define${Name}() throws InvalidPluginError: a back office would not save this ${name}.`}
        title={`Refused: ${count(check.issues.length, 'mistake')}`}
      />
    );
  }
  if (check.warnings.length > 0) {
    return (
      <Findings
        icon={<TriangleAlertIcon className="size-4 text-warning" />}
        rows={check.warnings}
        subtitle={`lint${Name}() finds what works but is likely a mistake: the ${name} can be saved.`}
        title={`Accepted, with ${count(check.warnings.length, 'warning')}`}
      />
    );
  }
  return (
    <Findings
      icon={<CircleCheckIcon className="size-4 text-success" />}
      rows={[]}
      subtitle={`The ${name} is valid, and lint${Name}() finds nothing.`}
      title="Accepted, no warning"
    />
  );
}

function Findings({
  icon,
  rows,
  subtitle,
  title,
}: {
  icon: React.ReactNode;
  rows: { path: (number | string)[]; code?: string; message: string }[];
  subtitle?: string;
  title: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          {icon} {title}
        </h2>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <ul className="space-y-2">
        {rows.map(({ path, code, message }, index) => (
          <li className="rounded-md border p-3 text-sm" key={index}>
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs font-medium">
                {path.length === 0 ? '(the whole)' : path.join('.')}
              </code>
              {code && <Badge variant="outline">{code}</Badge>}
            </div>
            <p className="mt-1 text-muted-foreground">{message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
