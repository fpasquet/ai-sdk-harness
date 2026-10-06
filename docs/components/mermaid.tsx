'use client';

import { useTheme } from 'next-themes';
import { use, useId, useSyncExternalStore } from 'react';

/**
 * A Mermaid diagram, from the ` ```mermaid ` code blocks of the pages and of the READMEs they
 * include (`remarkMdxMermaid` turns each into this component). Rendered in the browser only, in the
 * page's light or dark theme; GitHub renders the same blocks natively.
 */
export function Mermaid({ chart }: { chart: string }) {
  const isClient = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  if (!isClient) return null;
  return <MermaidContent chart={chart} />;
}

/** Mermaid itself, then each diagram per theme: loaded and rendered once. */
const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let promise = cache.get(key) as Promise<T> | undefined;
  if (promise === undefined) {
    promise = load();
    cache.set(key, promise);
  }
  return promise;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cached('mermaid', () => import('mermaid')));
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: resolvedTheme === 'dark' ? 'dark' : 'default',
  });
  const { svg } = use(cached(`${chart}-${resolvedTheme}`, () => mermaid.render(id, chart)));
  // Mermaid's own SVG, rendered with `securityLevel: 'strict'` from diagrams of this repository.
  return <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}
