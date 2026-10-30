/** The proxy's exit code once idle: its systemd unit powers the machine off on it, and only on it. */
export const IDLE_EXIT_CODE = 100;

/** How often the proxy checks whether it serves a sandbox. */
const CHECK_EVERY_MS = 30_000;

/**
 * Calls `onIdle` once no sandbox was registered for `idleMs`, counted from now: a proxy the service
 * started ahead of a sandbox that never came, or one the service could not stop, powers its machine
 * off rather than run unused. Returns what stops the watch.
 */
export function watchIdle({
  idleMs,
  sandboxes,
  onIdle,
  now = Date.now,
}: {
  idleMs: number;
  /** How many sandboxes the proxy serves. */
  sandboxes: () => number;
  onIdle: () => void;
  now?: () => number;
}): () => void {
  let busyAt = now();
  const timer = setInterval(
    () => {
      if (sandboxes() > 0) busyAt = now();
      else if (now() - busyAt >= idleMs) {
        clearInterval(timer);
        onIdle();
      }
    },
    Math.min(CHECK_EVERY_MS, idleMs),
  );
  timer.unref();
  return () => clearInterval(timer);
}
