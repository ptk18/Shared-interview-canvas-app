import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttle } from './throttle';

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first call immediately and collapses the rest into one trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t(1); t(2); t(3);
    expect(fn.mock.calls).toEqual([[1]]);
    vi.advanceTimersByTime(50);
    expect(fn.mock.calls).toEqual([[1], [3]]);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('sends at roughly the interval during a continuous drag', () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    for (let ms = 0; ms < 500; ms += 10) {
      t(ms);
      vi.advanceTimersByTime(10);
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('can flush or cancel the pending trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t('a'); t('b');
    t.flush();
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
    t('c');
    t.cancel();
    vi.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
  });
});
