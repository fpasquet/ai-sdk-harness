import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../common/logger.js';
import { MetricsSampler, parsePressure } from './metrics-sampler.js';

describe('the metrics sampler of the agent', () => {
  let root: string;
  let proc: string;
  let state: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gce-metrics-'));
    proc = join(root, 'proc');
    state = join(root, 'state');
    mkdirSync(join(proc, 'pressure'), { recursive: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  /** `/proc/stat` with the CPU times `user system idle steal` of the whole machine, and 2 CPUs. */
  const stat = (user: number, system: number, idle: number, steal = 0): void =>
    writeFileSync(
      join(proc, 'stat'),
      `cpu  ${user} 0 ${system} ${idle} 0 0 0 ${steal} 0 0\ncpu0 1 0 1 1 0 0 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0 0 0\nintr 1\n`,
    );

  const samplerOf = (intervalMs = 30_000): MetricsSampler =>
    new MetricsSampler({
      stateDirectory: state,
      intervalMs,
      procDirectory: proc,
      logger: silentLogger,
    });

  it('reads the CPU since the sample before, the memory, the pressure and the OOM kills', () => {
    stat(100, 50, 850);
    writeFileSync(
      join(proc, 'meminfo'),
      'MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:    3000000 kB\n',
    );
    writeFileSync(
      join(proc, 'pressure/cpu'),
      'some avg10=1.50 avg60=0.70 avg300=0.13 total=273\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    );
    writeFileSync(
      join(proc, 'pressure/memory'),
      'some avg10=0.00 avg60=0.25 avg300=0.00 total=6\n',
    );
    writeFileSync(join(proc, 'vmstat'), 'nr_free_pages 1\noom_kill 3\npgfault 4\n');
    const sampler = samplerOf();
    stat(400, 100, 1400, 100);

    expect(sampler.sample()).toEqual({
      at: expect.any(String) as unknown,
      // 350 busy ticks of 1000, 100 of them stolen.
      cpuPercent: 45,
      cpuStealPercent: 10,
      cpuCount: 2,
      memoryTotalBytes: 4_096_000_000,
      memoryUsedBytes: 1_024_000_000,
      cpuPressure: { someAvg10: 1.5, someAvg60: 0.7, fullAvg10: 0, fullAvg60: 0 },
      memoryPressure: { someAvg10: 0, someAvg60: 0.25 },
      oomKills: 3,
    });
  });

  it('leaves out what the kernel does not report', () => {
    rmSync(proc, { recursive: true });

    expect(samplerOf().sample()).toEqual({ at: expect.any(String) as unknown });
    expect(parsePressure('nothing')).toBeUndefined();
  });

  it('keeps its samples on disk, for an agent restarted to answer those after a time', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-25T10:00:00.000Z') });
    stat(1, 1, 1);
    const first = samplerOf();
    first.sample();
    vi.setSystemTime(Date.parse('2026-11-25T10:00:30.000Z'));
    first.sample();
    // A line cut by a power-off mid-write.
    writeFileSync(join(state, 'metrics.jsonl'), '{"at":"2026-11', { flag: 'a' });

    const restarted = samplerOf();
    expect(restarted.since().samples.map(({ at }) => at)).toEqual([
      '2026-11-25T10:00:00.000Z',
      '2026-11-25T10:00:30.000Z',
    ]);
    expect(restarted.since(Date.parse('2026-11-25T10:00:00.000Z'))).toEqual({
      intervalSeconds: 30,
      samples: [expect.objectContaining({ at: '2026-11-25T10:00:30.000Z' })],
    });
  });

  it('keeps a day of samples, its file written whole again once twice as long', () => {
    stat(1, 1, 1);
    const sampler = samplerOf();
    for (let i = 0; i < 2 * 2880 + 10; i++) sampler.sample();

    expect(sampler.since().samples).toHaveLength(2880);
    const lines = readFileSync(join(state, 'metrics.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2880 + 10);
    expect(samplerOf().since().samples).toHaveLength(2880);
  });

  it('samples every interval once started, until stopped, and never with an interval of 0', () => {
    vi.useFakeTimers();
    stat(1, 1, 1);
    const sampler = samplerOf(30_000);
    sampler.start();
    vi.advanceTimersByTime(90_000);
    sampler.stop();
    vi.advanceTimersByTime(90_000);
    expect(sampler.since().samples).toHaveLength(3);

    const never = samplerOf(0);
    never.start();
    vi.advanceTimersByTime(90_000);
    expect(never.since().samples).toHaveLength(3);
  });
});
