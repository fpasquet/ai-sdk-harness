/** A task waiting for its place. */
interface Waiter {
  group: unknown;
  start: () => void;
}

/**
 * Runs tasks at most `limit` at a time, the others waiting their turn in the order they came:
 * shared, it holds several runs of trials to one limit.
 *
 * `exclusive`, tasks of different groups never run at once, and the first task of a group runs
 * alone: trials in one sandbox share its HOME, where the runtime writes the skills of its agent at
 * each turn. Once that first task is over, the others of its group join it; the next group waits
 * until none is left running.
 */
export class Limiter {
  private active = 0;
  /** The group of the tasks running, or of the last ones. */
  private group: unknown;
  /** The first task of `group` is over: the others may run beside each other. */
  private ready = false;
  private readonly waiting: Waiter[] = [];

  constructor(
    readonly limit: number,
    private readonly exclusive = false,
  ) {}

  /** Runs `task` once a place is free for its `group`, and frees it when the task is over. */
  async run<T>(task: () => Promise<T>, group?: unknown): Promise<T> {
    if (this.waiting.length > 0 || !this.mayStart(group)) {
      await new Promise<void>((start) => this.waiting.push({ group, start }));
    } else {
      this.enter(group);
    }
    try {
      return await task();
    } finally {
      this.active -= 1;
      if (group === this.group) this.ready = true;
      this.next();
    }
  }

  private mayStart(group: unknown): boolean {
    if (this.active >= this.limit) return false;
    return !this.exclusive || this.active === 0 || (group === this.group && this.ready);
  }

  private enter(group: unknown): void {
    if (group !== this.group) {
      this.group = group;
      this.ready = false;
    }
    this.active += 1;
  }

  /** Starts the waiting tasks that may: those of the group running first, to switch less. */
  private next(): void {
    for (;;) {
      const index = this.exclusive
        ? this.waiting.findIndex(({ group }) => group === this.group && this.mayStart(group))
        : -1;
      const picked = index !== -1 ? index : this.mayStart(this.waiting[0]?.group) ? 0 : -1;
      const waiter = picked === -1 ? undefined : this.waiting.splice(picked, 1)[0];
      if (waiter === undefined) return;
      this.enter(waiter.group);
      waiter.start();
    }
  }
}
