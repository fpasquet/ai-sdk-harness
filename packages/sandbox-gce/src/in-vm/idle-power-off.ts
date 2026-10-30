import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '../common/logger.js';

/** What the agent powers its machine off with, should no sandbox take it. */
export interface IdlePowerOffSettings {
  /** How long after the machine's boot it waits to be configured. */
  afterMs: number;
  /**
   * Where the agent marks that it was configured since the machine booted: a directory emptied at
   * each boot, `/run`'s, so that an agent restarted by systemd after the sandbox took the machine
   * never powers it off.
   */
  runDirectory: string;
  logger: Logger;
  /** Powers the machine off: `systemctl poweroff` without it. Tests only. */
  powerOff?: () => void;
  /** How long the machine has been up: the system's uptime without it. Tests only. */
  uptimeMs?: () => number;
}

/** Powers the machine off as root, through systemd: the guest halts, and Compute Engine stops it. */
function systemPowerOff(logger: Logger): void {
  execFile('systemctl', ['poweroff'], (error) => {
    if (error !== null) logger.error(`The machine could not be powered off: ${error.message}`);
  });
}

/**
 * Powers the machine off once it ran `afterMs` since its boot without the agent being configured:
 * a machine the service booted ahead of a sandbox that never came stops costing but its disk, and
 * the service deletes it as it meets it. Being configured, what the service does for the sandbox
 * that takes the machine, cancels it for the rest of the boot. Returns what marks it configured,
 * and what stops the watch.
 */
export function watchIdlePowerOff({
  afterMs,
  runDirectory,
  logger,
  powerOff = () => systemPowerOff(logger),
  uptimeMs = () => uptime() * 1000,
}: IdlePowerOffSettings): { configured(): void; stop(): void } {
  const marker = join(runDirectory, 'configured');
  let timer: NodeJS.Timeout | undefined;
  if (!existsSync(marker)) {
    timer = setTimeout(
      () => {
        logger.info(`Not configured ${afterMs / 60_000} min after boot: powering the machine off`);
        powerOff();
      },
      Math.max(0, afterMs - uptimeMs()),
    );
    timer.unref();
  }
  const stop = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    configured: () => {
      stop();
      try {
        mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(marker, '', { mode: 0o600 });
      } catch (error) {
        logger.warn(`The configuration could not be marked in ${runDirectory}: ${String(error)}`);
      }
    },
    stop,
  };
}
