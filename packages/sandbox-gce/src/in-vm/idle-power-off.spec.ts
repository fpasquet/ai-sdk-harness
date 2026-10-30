import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { watchIdlePowerOff } from './idle-power-off.js';

describe('the idle power-off of a machine booted ahead of a sandbox', () => {
  let runDirectory: string;
  const minute = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    runDirectory = join(mkdtempSync(join(tmpdir(), 'gce-run-')), 'ai-sdk-sandbox');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(join(runDirectory, '..'), { recursive: true, force: true });
  });

  it('powers the machine off once it ran so long since its boot, never configured', () => {
    const powerOff = vi.fn();
    watchIdlePowerOff({
      afterMs: 16 * minute,
      runDirectory,
      logger: silentLogger,
      powerOff,
      uptimeMs: () => 2 * minute,
    });

    vi.advanceTimersByTime(14 * minute - 1);
    expect(powerOff).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(powerOff).toHaveBeenCalledOnce();
  });

  it('powers it off at once when the agent starts past the delay', () => {
    const powerOff = vi.fn();
    watchIdlePowerOff({
      afterMs: 16 * minute,
      runDirectory,
      logger: silentLogger,
      powerOff,
      uptimeMs: () => 20 * minute,
    });

    vi.advanceTimersByTime(0);
    expect(powerOff).toHaveBeenCalledOnce();
  });

  it('never powers it off once configured, an agent restarted in the same boot included', () => {
    const powerOff = vi.fn();
    const settings = {
      afterMs: 16 * minute,
      runDirectory,
      logger: silentLogger,
      powerOff,
      uptimeMs: () => minute,
    };
    watchIdlePowerOff(settings).configured();
    expect(existsSync(join(runDirectory, 'configured'))).toBe(true);

    // Restarted by systemd later in the same boot, past the delay.
    watchIdlePowerOff({ ...settings, uptimeMs: () => 30 * minute });
    vi.advanceTimersByTime(60 * minute);
    expect(powerOff).not.toHaveBeenCalled();
  });

  it('stops watching when the agent closes', () => {
    const powerOff = vi.fn();
    watchIdlePowerOff({
      afterMs: minute,
      runDirectory,
      logger: silentLogger,
      powerOff,
      uptimeMs: () => 0,
    }).stop();

    vi.advanceTimersByTime(10 * minute);
    expect(powerOff).not.toHaveBeenCalled();
    expect(existsSync(join(runDirectory, 'configured'))).toBe(false);
  });
});
