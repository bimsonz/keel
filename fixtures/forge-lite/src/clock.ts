/** Source of the current time, in milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

/**
 * The real clock. It reads the time only when asked, so it is safe to build
 * at module scope in a Worker, where the time does not advance until a
 * request arrives.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock that moves only when told to. Tests use it to drive session expiry. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError("a clock cannot go backwards");
    this.#now += ms;
  }
}
