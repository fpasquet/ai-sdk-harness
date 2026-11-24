'use client';

import { TimerIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { TurnTimings } from '@/lib/conversations';

/** A duration as people read it: `0.4 s`, `12 s`, `5 min 12 s`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/**
 * How long a turn took, under the agent's answer: the sandbox opened for it, the session ready, the
 * agent's first output, the turn itself and the whole.
 */
export function TurnTimingsLine({ timings }: { timings: TurnTimings }) {
  const { firstOutput, ready, sandbox, total, turn } = timings;
  const parts = [
    ...(sandbox ? [`sandbox ${sandbox.kind} in ${formatDuration(sandbox.ms)}`] : []),
    `session ready in ${formatDuration(ready)}`,
    ...(firstOutput === undefined ? [] : [`first output after ${formatDuration(firstOutput)}`]),
    `turn ${formatDuration(turn)}`,
    `total ${formatDuration(total)}`,
  ];
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <TimerIcon className="size-3.5 shrink-0" />
      {parts.join(' · ')}
    </p>
  );
}

/** The milliseconds since `active` became true, ticking every second; 0 while inactive. */
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => {
      clearInterval(timer);
      setElapsed(0);
    };
  }, [active]);
  return active ? elapsed : 0;
}
