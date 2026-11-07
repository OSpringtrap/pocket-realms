export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Instant clock for the simulator and tests: sleeps resolve immediately, timers never fire on their own. */
export function instantClock(): Clock {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
}
