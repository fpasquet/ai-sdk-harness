/**
 * Runs tasks at most `limit` at a time, the others waiting their turn in the order they came:
 * shared, it holds several runs of trials to one limit.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly limit: number) {}

  /** Runs `task` once a place is free, and frees it when the task is over. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
