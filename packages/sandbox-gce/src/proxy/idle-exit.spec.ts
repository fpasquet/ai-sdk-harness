import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchIdle } from './idle-exit.js';

describe('the idle watch of the proxy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls once no sandbox was registered for the delay, counted from the last one', () => {
    let sandboxes = 0;
    const onIdle = vi.fn();
    watchIdle({ idleMs: 10 * 60_000, sandboxes: () => sandboxes, onIdle });

    vi.advanceTimersByTime(5 * 60_000);
    sandboxes = 1;
    vi.advanceTimersByTime(20 * 60_000);
    sandboxes = 0;
    vi.advanceTimersByTime(9 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('stops watching when asked', () => {
    const onIdle = vi.fn();
    const stop = watchIdle({ idleMs: 60_000, sandboxes: () => 0, onIdle });

    stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
