import { describe, expect, it } from "vitest";
import { Pace, paced, slotAfter } from "../src/limits.ts";

const MINUTE = 60_000;

/** The most grants any sliding minute of `granted` holds. */
const busiest = (granted: readonly number[]) =>
  Math.max(...granted.map((at) => granted.filter((g) => g > at - MINUTE && g <= at).length));

/** A clock stopped at `at` that records each wait asked of it. */
function stopped(at = 0) {
  const waits: number[] = [];
  let now = at;
  return {
    waits,
    set: (t: number) => void (now = t),
    clock: { now: () => now, sleep: async (ms: number) => void waits.push(ms) },
  };
}

const TOKEN = "https://keel.test/v1/auth/oauth2/token";
const ok = () => new Response("{}", { status: 200 });

describe("the token pace", () => {
  it("[loadgen.pace-minute] grants no sliding minute more than its pace, and the next as soon as the minute allows", async () => {
    const granted: number[] = [];
    for (let i = 0; i < 130; i += 1) granted.push(slotAfter(granted, 0, 50));
    expect(busiest(granted)).toBe(50);
    expect([granted[49], granted[50], granted[99], granted[100], granted[129]]).toEqual([
      0,
      MINUTE,
      MINUTE,
      2 * MINUTE,
      2 * MINUTE,
    ]);

    // Taken all at once by many runs, the pace hands out the same slots.
    const t = stopped();
    const pace = new Pace(50, t.clock);
    await Promise.all(Array.from({ length: 130 }, () => pace.take()));
    expect(t.waits.toSorted((a, b) => a - b)).toEqual(granted.filter((g) => g > 0));
  });

  it("[loadgen.pace-tokens-only] holds only the token requests to the pace", async () => {
    const t = stopped();
    const sent: string[] = [];
    const fetch = paced(
      async (input) => {
        sent.push(input);
        return ok();
      },
      new Pace(50, t.clock),
      TOKEN,
    );
    await Promise.all(
      Array.from({ length: 60 }, () => fetch(TOKEN, { method: "POST", body: "grant_type=x" })),
    );
    expect(t.waits).toHaveLength(10);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => fetch(`https://keel.test/v1/changes/c${i}`, {})),
    );
    expect(t.waits).toHaveLength(10);
    expect(sent).toHaveLength(90);
  });

  it("[loadgen.pace-refused] a 429 pauses every token request for its window and is answered as it came, never sent again", async () => {
    const t = stopped(1_000);
    const pace = new Pace(50, t.clock);
    let calls = 0;
    const fetch = paced(
      async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { status: 429, headers: { "retry-after": "30" } })
          : ok();
      },
      pace,
      TOKEN,
    );
    const refused = await fetch(TOKEN, { method: "POST" });
    expect([refused.status, calls, pace.refused]).toEqual([429, 1, 1]);
    await fetch(TOKEN, { method: "POST" });
    expect(t.waits).toEqual([30_000]);

    // With no time asked for, the pause is the limit's minute.
    t.set(100_000);
    pace.refusedFor(null);
    await pace.take();
    expect(t.waits.at(-1)).toBe(MINUTE);
  });
});
