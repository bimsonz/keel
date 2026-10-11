/** A held slot. `queued` says whether the holder waited for it; `release` is idempotent. */
export interface Permit {
  readonly queued: boolean;
  readonly release: () => void;
}

/**
 * At most `size` holders at once; the rest wait, first come first served.
 * Nothing is ever refused: Dynamic Worker concurrency limits throw rather
 * than queue (the 5th call per request fails, spike S14), so a VerifierDO
 * runs its isolates under one of these instead.
 */
export class Semaphore {
  readonly size: number;
  #free: number;
  readonly #waiting: Array<(permit: Permit) => void> = [];

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1)
      throw new RangeError(`a semaphore needs at least one slot, not ${size}`);
    this.size = size;
    this.#free = size;
  }

  /** Holders right now. */
  get inFlight(): number {
    return this.size - this.#free;
  }

  /** Waiters right now. */
  get waiting(): number {
    return this.#waiting.length;
  }

  acquire(): Promise<Permit> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#permit(false));
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /** Runs `task` holding a slot, and releases it however the task ends. */
  async run<T>(task: (queued: boolean) => Promise<T>): Promise<T> {
    const permit = await this.acquire();
    try {
      return await task(permit.queued);
    } finally {
      permit.release();
    }
  }

  #permit(queued: boolean): Permit {
    let released = false;
    return {
      queued,
      release: () => {
        if (released) return;
        released = true;
        // The slot passes straight to the next waiter, so no newcomer can overtake it.
        const next = this.#waiting.shift();
        if (next === undefined) this.#free++;
        else next(this.#permit(true));
      },
    };
  }
}
