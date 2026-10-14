import { describe, expect, it } from 'vitest';

import { Limiter } from './limiter.js';

describe('Limiter', () => {
  it('runs at most its limit of tasks at once, in the order they came', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (index: number) => async () => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return index;
    };

    const results = await Promise.all([0, 1, 2, 3, 4].map((index) => limiter.run(task(index))));

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('exclusive, runs one group at a time, its first task alone', async () => {
    const limiter = new Limiter(3, true);
    const log: string[] = [];
    const running = new Set<string>();
    const mixed: string[][] = [];
    const task = (name: string) => async () => {
      running.add(name);
      log.push(`start ${name}`);
      if (new Set([...running].map((each) => each[0])).size > 1) mixed.push([...running]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running.delete(name);
      log.push(`end ${name}`);
    };

    await Promise.all(
      ['a1', 'b1', 'a2', 'a3', 'b2'].map((name) => limiter.run(task(name), name[0])),
    );

    expect(mixed).toEqual([]);
    // a1 alone, then a2 and a3 together; b's turn once no a is left, b1 alone first.
    expect(log).toEqual([
      'start a1',
      'end a1',
      'start a2',
      'start a3',
      'end a2',
      'end a3',
      'start b1',
      'end b1',
      'start b2',
      'end b2',
    ]);
  });

  it('frees the place of a task that fails', async () => {
    const limiter = new Limiter(1);

    await expect(limiter.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await expect(limiter.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });
});
