export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Runs a pending trailing call now. */
  flush(): void;
  /** Drops a pending trailing call. */
  cancel(): void;
}

/**
 * Calls `fn` at most once per `ms`: the first call runs immediately, later calls
 * within the window collapse into one trailing call with the latest arguments.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;

  const run = (args: A) => {
    last = Date.now();
    pending = undefined;
    fn(...args);
  };

  const throttled = ((...args: A) => {
    const wait = last + ms - Date.now();
    if (wait <= 0 && !timer) {
      run(args);
      return;
    }
    pending = args;
    timer ??= setTimeout(() => {
      timer = undefined;
      if (pending) run(pending);
    }, Math.max(0, wait));
  }) as Throttled<A>;

  throttled.flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) run(pending);
  };
  throttled.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return throttled;
}
