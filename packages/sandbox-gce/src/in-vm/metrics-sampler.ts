import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from '../common/logger.js';
import type { MetricSample, PressureSample, SandboxMetrics } from '../protocol/api.js';

/** How often the agent samples its machine by default: every 30 s. */
export const DEFAULT_METRICS_INTERVAL_MS = 30_000;

/** How many samples are kept: a day of them, every 30 s. */
const CAPACITY = 2880;

/** The file the samples are kept in, one JSON object per line, under the agent's state directory. */
const FILE = 'metrics.jsonl';

/** What the sampler is made with. */
export interface MetricsSamplerSettings {
  /** Root's, on the machine's disk: the samples outlive a stop there. */
  stateDirectory: string;
  /** How often to sample, in milliseconds: never by itself with 0, only when asked. */
  intervalMs: number;
  /** Where `/proc` is. Tests only. */
  procDirectory?: string;
  logger: Logger;
}

/** The CPU times of `/proc/stat`'s first line, in ticks: all of them, idle, stolen. */
interface CpuTimes {
  total: number;
  idle: number;
  steal: number;
}

const percent = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

/** The CPU times of the whole machine, and how many CPUs it has, from `/proc/stat`. */
function parseStat(text: string): { times?: CpuTimes; cpuCount: number } {
  const lines = text.split('\n');
  const cpuCount = lines.filter((line) => /^cpu\d+\s/.test(line)).length;
  const first = lines.find((line) => line.startsWith('cpu '));
  if (first === undefined) return { cpuCount };
  // user nice system idle iowait irq softirq steal: guest is counted in user already.
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    first.trim().split(/\s+/).slice(1).map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { times: { total, idle: idle + iowait, steal }, cpuCount };
}

/** `MemTotal` and `MemAvailable` of `/proc/meminfo`, in bytes. */
function parseMeminfo(text: string): Pick<MetricSample, 'memoryTotalBytes' | 'memoryUsedBytes'> {
  const kib = (key: string): number | undefined => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
  };
  const total = kib('MemTotal');
  const available = kib('MemAvailable');
  if (total === undefined) return {};
  return {
    memoryTotalBytes: total,
    ...(available === undefined ? {} : { memoryUsedBytes: total - available }),
  };
}

/** A file of `/proc/pressure`: `some avg10=0.00 avg60=0.07 avg300=0.13 total=…`, then `full …`. */
export function parsePressure(text: string): PressureSample | undefined {
  const averages = (kind: string): [number, number] | undefined => {
    const match = new RegExp(`^${kind} avg10=([\\d.]+) avg60=([\\d.]+)`, 'm').exec(text);
    return match === null ? undefined : [Number(match[1]), Number(match[2])];
  };
  const some = averages('some');
  if (some === undefined) return undefined;
  const full = averages('full');
  return {
    someAvg10: some[0],
    someAvg60: some[1],
    ...(full === undefined ? {} : { fullAvg10: full[0], fullAvg60: full[1] }),
  };
}

/** `fields` without those left undefined. */
const defined = <T extends object>(fields: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

/** `oom_kill` of `/proc/vmstat`: the processes the OOM killer killed since boot. */
function parseOomKills(text: string): number | undefined {
  const match = /^oom_kill (\d+)$/m.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Samples the machine every `intervalMs`, from `/proc` alone, cheap enough to run for as long as
 * the machine does: the CPU's busy and stolen shares since the sample before, the memory in use,
 * the pressure of both when the kernel reports it, and the processes the OOM killer killed. Keeps
 * the last day of samples in memory and in a file of the agent's state directory, on the machine's
 * disk, so that they outlive a stop of the machine and a restart of the agent. Never fails: what
 * it cannot read is left out, what it cannot write logged.
 */
export class MetricsSampler {
  private readonly samples: MetricSample[] = [];
  private previous?: CpuTimes;
  private timer?: NodeJS.Timeout;
  /** Lines appended to the file since it was last written whole. */
  private appended = 0;

  constructor(private readonly settings: MetricsSamplerSettings) {
    this.load();
    // The CPU's first share is counted from here.
    this.previous = parseStat(this.read('stat') ?? '').times;
  }

  /** Samples every `intervalMs` from now on, without keeping the process alive. */
  start(): void {
    if (this.settings.intervalMs <= 0 || this.timer !== undefined) return;
    this.timer = setInterval(() => this.sample(), this.settings.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The samples taken after `since`, milliseconds since the epoch, every one kept without it. */
  since(since?: number): SandboxMetrics {
    const samples =
      since === undefined
        ? [...this.samples]
        : this.samples.filter(({ at }) => Date.parse(at) > since);
    return { intervalSeconds: this.settings.intervalMs / 1000, samples };
  }

  /** Takes a sample now, kept with the others. */
  sample(): MetricSample {
    const sample: MetricSample = {
      at: new Date().toISOString(),
      ...this.cpu(),
      ...parseMeminfo(this.read('meminfo') ?? ''),
      ...defined({
        cpuPressure: parsePressure(this.read('pressure/cpu') ?? ''),
        memoryPressure: parsePressure(this.read('pressure/memory') ?? ''),
        oomKills: parseOomKills(this.read('vmstat') ?? ''),
      }),
    };
    this.keep(sample);
    return sample;
  }

  /** The CPU's busy and stolen shares since the sample before, and how many CPUs there are. */
  private cpu(): Pick<MetricSample, 'cpuCount' | 'cpuPercent' | 'cpuStealPercent'> {
    const { times, cpuCount } = parseStat(this.read('stat') ?? '');
    const previous = this.previous;
    this.previous = times ?? previous;
    const counted = cpuCount > 0 ? { cpuCount } : {};
    if (times === undefined || previous === undefined) return counted;
    const total = times.total - previous.total;
    return {
      ...counted,
      cpuPercent: percent(total - (times.idle - previous.idle), total),
      cpuStealPercent: percent(times.steal - previous.steal, total),
    };
  }

  private get file(): string {
    return join(this.settings.stateDirectory, FILE);
  }

  /** A file of `/proc`, `undefined` when the kernel has none. */
  private read(name: string): string | undefined {
    try {
      return readFileSync(join(this.settings.procDirectory ?? '/proc', name), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** The samples of the file, the last {@link CAPACITY} of them, a line it cannot read skipped. */
  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter((line) => line !== '');
    // What the file holds beyond the samples kept counts toward its next rewrite.
    this.appended = Math.max(0, lines.length - CAPACITY);
    for (const line of lines) {
      try {
        const sample = JSON.parse(line) as MetricSample;
        if (typeof sample.at === 'string') this.samples.push(sample);
      } catch {
        // Cut by a power-off mid-write, or empty.
      }
    }
    this.samples.splice(0, Math.max(0, this.samples.length - CAPACITY));
  }

  /**
   * Keeps `sample` in memory and appends it to the file, which is written whole again, the samples
   * kept alone, once it holds twice as many.
   */
  private keep(sample: MetricSample): void {
    this.samples.push(sample);
    if (this.samples.length > CAPACITY) this.samples.shift();
    try {
      mkdirSync(this.settings.stateDirectory, { recursive: true, mode: 0o700 });
      if (++this.appended < CAPACITY) {
        appendFileSync(this.file, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
        return;
      }
      const lines = this.samples.map((kept) => `${JSON.stringify(kept)}\n`).join('');
      writeFileSync(`${this.file}.tmp`, lines, { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
      this.appended = 0;
    } catch (error) {
      this.settings.logger.warn(`The metrics could not be written: ${String(error)}`);
    }
  }
}
