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

  it('frees the place of a task that fails', async () => {
    const limiter = new Limiter(1);

    await expect(limiter.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await expect(limiter.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });
});
