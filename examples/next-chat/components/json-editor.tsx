'use client';

import type { ReactNode } from 'react';

import { useRef } from 'react';

import { cn } from '@/lib/utils';

/** A string, a number, a constant or a punctuation mark of JSON; a string followed by `:` is a key. */
const TOKEN =
  /("(?:\\.|[^"\\\n])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** In a string, what a command or a prompt reads: `$INPUT_PATH`, `${INPUT_PATH:-.}`, `$1`. */
const PARAMETER = /\$\{[^{}"]*\}|\$(?:[A-Za-z_]\w*|[1-9])/g;

/** The colours of One Light and One Dark Pro, as the code blocks of the example use them. */
const COLOURS = {
  key: 'text-[#e45649] dark:text-[#e06c75]',
  string: 'text-[#50a14f] dark:text-[#98c379]',
  parameter: 'font-semibold text-[#a626a4] dark:text-[#c678dd]',
  number: 'text-[#986801] dark:text-[#d19a66]',
  constant: 'text-[#0184bc] dark:text-[#56b6c2]',
  punctuation: 'text-muted-foreground',
};

/** A string of JSON, the parameters it reads standing out. */
function stringOf(text: string, offset: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PARAMETER)) {
    nodes.push(text.slice(last, match.index));
    nodes.push(
      <span className={COLOURS.parameter} key={offset + match.index}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

/** `text`, coloured as JSON: what is not a token of it — a mistake being typed — left as it is. */
export function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, string, colon, number, constant, punctuation] = match;
    const at = match.index;
    nodes.push(text.slice(last, at));
    if (string !== undefined && colon !== undefined) {
      nodes.push(
        <span className={COLOURS.key} key={at}>
          {string}
        </span>,
        <span className={COLOURS.punctuation} key={`${at}:`}>
          {colon}
        </span>,
      );
    } else if (string !== undefined) {
      nodes.push(
        <span className={COLOURS.string} key={at}>
          {stringOf(string, at)}
        </span>,
      );
    } else {
      const colour =
        number !== undefined
          ? COLOURS.number
          : constant !== undefined
            ? COLOURS.constant
            : COLOURS.punctuation;
      nodes.push(
        <span className={colour} key={at}>
          {number ?? constant ?? punctuation}
        </span>,
      );
    }
    last = at + whole.length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

/** What the text area and the colours under it share, so that each character falls in place. */
const LAYER = 'm-0 p-3 font-mono text-xs leading-5 whitespace-pre [tab-size:2]';

/**
 * A text area for JSON, coloured as you type: the text is drawn by a layer under the area, which
 * scrolls with it, and the area itself shows only the caret and the selection.
 */
export function JsonEditor({
  className,
  label,
  onChange,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const layer = useRef<HTMLPreElement>(null);
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
        className,
      )}
    >
      <pre aria-hidden className={cn(LAYER, 'absolute inset-0 overflow-hidden')} ref={layer}>
        {highlightJson(value)}
        {/* A last empty line takes its height, as in the text area. */}
        {'\n'}
      </pre>
      <textarea
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className={cn(
          LAYER,
          'absolute inset-0 size-full resize-none overflow-auto bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/20 selection:text-transparent',
        )}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (layer.current === null) return;
          layer.current.scrollTop = event.currentTarget.scrollTop;
          layer.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        value={value}
        wrap="off"
      />
    </div>
  );
}
