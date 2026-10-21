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

import type { CheckKind, PluginCheck, PluginSample } from '@/lib/plugin-check';

import { JsonEditor } from '@/components/json-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** How long the text must stay unchanged before it is checked again. */
const DEBOUNCE_MS = 300;

/** What each page checks, and with what. */
const KINDS = {
  plugin: { title: 'Check a plugin', name: 'plugin', define: 'definePlugin', lint: 'lintPlugin' },
  item: { title: 'Check an item', name: 'item', define: 'defineItem', lint: 'lintItem' },
} as const;

/**
 * A plugin — or an item, for `kind: 'item'` — as JSON, checked by the server as you type: the
 * mistakes that refuse it, then what is likely a mistake in what is accepted, each at its field.
 * What a back office that edits a marketplace shows next to its form.
 */
export function PluginChecker({ kind, samples }: { kind: CheckKind; samples: PluginSample[] }) {
  const [label, setLabel] = useState(samples[0]?.label ?? '');
  const [text, setText] = useState(samples[0]?.text ?? '');
  const [check, setCheck] = useState<PluginCheck>();

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/check?kind=${kind}`, { method: 'POST', body: text, signal: controller.signal })
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
  }, [kind, text]);

  const pick = (next: string) => {
    setLabel(next);
    setText(samples.find((sample) => sample.label === next)?.text ?? '');
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <FileCheckIcon className="size-5 shrink-0 text-muted-foreground" />
          <h1 className="truncate font-semibold">{KINDS[kind].title}</h1>
          <Badge className="hidden sm:inline-flex" variant="secondary">
            ai-sdk-harness-plugins
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <ButtonGroup aria-label="What to check">
            {(['plugin', 'item'] as const).map((other) => (
              <Button
                aria-current={other === kind ? 'page' : undefined}
                asChild
                key={other}
                size="sm"
                variant={other === kind ? 'secondary' : 'outline'}
              >
                <Link href={`/${other}-check`}>{other === 'plugin' ? 'A plugin' : 'An item'}</Link>
              </Button>
            ))}
          </ButtonGroup>
          <Button asChild size="sm" variant="ghost">
            <Link href="/">
              <ArrowLeftIcon /> Back to the chat
            </Link>
          </Button>
        </div>
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
          <JsonEditor
            className="min-h-64 flex-1"
            label={`The ${KINDS[kind].name}, as JSON`}
            onChange={setText}
            value={text}
          />
          <p className="text-xs text-muted-foreground">
            Checked by <code>{KINDS[kind].define}()</code>, then — once accepted — by{' '}
            <code>{KINDS[kind].lint}()</code>. Nothing is saved, nothing is run.
          </p>
        </section>
        <section aria-live="polite" className="min-h-0 overflow-y-auto">
          {check && <CheckResult check={check} kind={kind} />}
        </section>
      </main>
    </div>
  );
}

/** What the check says of the plugin or the item: refused, accepted with warnings, or clean. */
function CheckResult({ check, kind }: { check: PluginCheck; kind: CheckKind }) {
  const { define, lint, name } = KINDS[kind];
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (!check.json) {
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
        subtitle={`${define}() throws InvalidPluginError: a back office would not save this ${name}.`}
        title={`Refused: ${count(check.issues.length, 'mistake')}`}
      />
    );
  }
  if (check.warnings.length > 0) {
    return (
      <Findings
        icon={<TriangleAlertIcon className="size-4 text-warning" />}
        rows={check.warnings}
        subtitle={`${lint}() finds what works but is likely a mistake: the ${name} can be saved.`}
        title={`Accepted, with ${count(check.warnings.length, 'warning')}`}
      />
    );
  }
  return (
    <Findings
      icon={<CircleCheckIcon className="size-4 text-success" />}
      rows={[]}
      subtitle={`The ${name} is valid, and ${lint}() finds nothing.`}
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
