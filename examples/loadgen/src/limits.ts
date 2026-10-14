/**
 * Keel limits token requests to 60 a minute from one address (`TOKEN_LIMIT`).
 * Every run here mints its own tokens from the same address, so the run keeps
 * its requests under a pace of its own, with room left for other clients on
 * the address, and waits out a refusal rather than failing on it.
 */
export const TOKENS_PER_MINUTE = 50;

const MINUTE_MS = 60_000;

/**
 * The earliest time at or after `now` that another request may go, given the
 * times already granted (oldest first, never decreasing), so that no sliding
 * minute holds more than `perMinute` of them.
 */
export function slotAfter(granted: readonly number[], now: number, perMinute: number): number {
  const last = granted.at(-1) ?? now;
  const nth = granted.at(-perMinute);
  return Math.max(now, last, nth === undefined ? now : nth + MINUTE_MS);
}

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const REAL: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A pace shared by every run of the process: each `take` waits for its own slot. */
export class Pace {
  readonly #granted: number[] = [];
  readonly #perMinute: number;
  readonly #clock: Clock;
  #pausedUntil = 0;
  /** Requests the limit refused all the same. */
  refused = 0;

  constructor(perMinute: number, clock: Clock = REAL) {
    this.#perMinute = perMinute;
    this.#clock = clock;
  }

  /** Waits until a request may go; the slot is held from the moment it is given. */
  async take(): Promise<void> {
    const now = this.#clock.now();
    while (this.#granted.length > this.#perMinute && (this.#granted[0] ?? now) <= now - MINUTE_MS)
      this.#granted.shift();
    const at = Math.max(slotAfter(this.#granted, now, this.#perMinute), this.#pausedUntil);
    this.#granted.push(at);
    if (at > now) await this.#clock.sleep(at - now);
  }

  /** A refusal pauses every request for the limit's window, or what its answer asked. */
  refusedFor(retryAfter: string | null): void {
    this.refused += 1;
    const seconds = Number(retryAfter);
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MINUTE_MS;
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#clock.now() + wait);
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * `fetch` with every request to `tokenEndpoint` held to `pace`; every other
 * request goes at once. A 429 from it pauses the pace and is answered as it
 * came: the request is never sent again as it was, since its signed assertion
 * and proof are each good once, and the caller's retry signs anew.
 */
export function paced(fetch: Fetch, pace: Pace, tokenEndpoint: string): Fetch {
  return async (input, init) => {
    if (input !== tokenEndpoint) return fetch(input, init);
    await pace.take();
    const answer = await fetch(input, init);
    if (answer.status === 429) pace.refusedFor(answer.headers.get("retry-after"));
    return answer;
  };
}
