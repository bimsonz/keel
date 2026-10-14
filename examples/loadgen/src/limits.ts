/**
 * Keel limits token requests to 60 a minute from one address (`TOKEN_LIMIT`).
 * Every run here mints its own tokens from the same address, so the run keeps
 * its requests under a pace of its own, with room left for other clients on
 * the address, and waits out a refusal rather than failing on it.
 */
export const TOKENS_PER_MINUTE = 50;
/** The share the run's readers keep: one refresh in five minutes each, never queued behind the agents. */
export const READER_TOKENS_PER_MINUTE = 5;
/** The agents' share: the rest of the run's pace. */
export const AGENT_TOKENS_PER_MINUTE = TOKENS_PER_MINUTE - READER_TOKENS_PER_MINUTE;

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
  /** Requests held past their signature's life, answered without being sent and signed again. */
  signedAgain = 0;

  constructor(perMinute: number, clock: Clock = REAL) {
    this.#perMinute = perMinute;
    this.#clock = clock;
  }

  /** Waits until a request may go, and answers how long that was; the slot is held from the moment it is given. */
  async take(): Promise<number> {
    const now = this.#clock.now();
    while (this.#granted.length > this.#perMinute && (this.#granted[0] ?? now) <= now - MINUTE_MS)
      this.#granted.shift();
    const at = Math.max(slotAfter(this.#granted, now, this.#perMinute), this.#pausedUntil);
    this.#granted.push(at);
    if (at > now) await this.#clock.sleep(at - now);
    return at - now;
  }

  /** A refusal pauses every request for the limit's window, or what its answer asked. */
  refusedFor(retryAfter: string | null): void {
    this.refused += 1;
    const seconds = Number(retryAfter);
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MINUTE_MS;
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#clock.now() + wait);
  }
}

/**
 * The run's two paces: its agents', and its readers' apart, so a reader's
 * refresh never waits behind a thousand agents' queue (lg1000c's count froze
 * for sixteen minutes that way). Together they hold to `perMinute`, at most
 * `TOKENS_PER_MINUTE`.
 */
export function paces(options: { readonly perMinute?: number; readonly clock?: Clock } = {}): {
  readonly agents: Pace;
  readonly readers: Pace;
} {
  const { perMinute = TOKENS_PER_MINUTE, clock = REAL } = options;
  if (perMinute <= READER_TOKENS_PER_MINUTE || perMinute > TOKENS_PER_MINUTE)
    throw new Error(
      `A run's pace is more than ${READER_TOKENS_PER_MINUTE} and at most ${TOKENS_PER_MINUTE} tokens a minute`,
    );
  return {
    agents: new Pace(perMinute - READER_TOKENS_PER_MINUTE, clock),
    readers: new Pace(READER_TOKENS_PER_MINUTE, clock),
  };
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * How long a token request may wait for its slot. Its caller signs it before
 * `fetch` is called: Keel takes a client assertion and a proof for a minute
 * from when they were made, so a request held much longer would reach Keel
 * dead and be refused as unverifiable.
 */
export const FRESH_MS = 20_000;

/**
 * One client's `fetch`, with every request to `tokenEndpoint` held to `pace`;
 * every other request goes at once. A token request that waited longer than
 * `FRESH_MS` is not sent: it is answered 429 at its slot, and the slot is kept
 * for the client's next token request, which its retry signs anew. A 429 from
 * Keel pauses the pace and is answered as it came, never sent again as it was,
 * since its signed assertion and proof are each good once.
 */
export function paced(fetch: Fetch, pace: Pace, tokenEndpoint: string): Fetch {
  let kept = 0;
  return async (input, init) => {
    if (input !== tokenEndpoint) return fetch(input, init);
    if (kept > 0) kept -= 1;
    else if ((await pace.take()) > FRESH_MS) {
      kept += 1;
      pace.signedAgain += 1;
      return new Response(
        JSON.stringify({
          error: "slow_down",
          error_description: "held for its slot past its signature's life: sign it again",
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } },
      );
    }
    const answer = await fetch(input, init);
    if (answer.status === 429) pace.refusedFor(answer.headers.get("retry-after"));
    return answer;
  };
}
