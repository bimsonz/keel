import { describe, expect, it } from "vitest";
import {
  AGENT_TOKENS_PER_MINUTE,
  FRESH_MS,
  Pace,
  READER_TOKENS_PER_MINUTE,
  TOKENS_PER_MINUTE,
  paced,
  paces,
  slotAfter,
} from "../src/limits.ts";

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
  it("[loadgen.reader-ahead] gives a reader's refresh its slot at once while the agents' queue is a minute deep, the two together within the run's pace", async () => {
    expect(AGENT_TOKENS_PER_MINUTE + READER_TOKENS_PER_MINUTE).toBe(TOKENS_PER_MINUTE);
    // A lower pace leaves the readers their share; a pace that leaves the agents none, or passes the run's, is refused.
    expect(() => paces({ perMinute: READER_TOKENS_PER_MINUTE })).toThrow("tokens a minute");
    expect(() => paces({ perMinute: TOKENS_PER_MINUTE + 1 })).toThrow("tokens a minute");
    const t = stopped();
    const pace = paces({ clock: t.clock });
    // A thousand agents start at once: their queue reaches minutes ahead.
    const agents = Array.from({ length: 1000 }, () => pace.agents.take());
    const deepest = Math.max(...t.waits);
    expect(deepest).toBeGreaterThan(MINUTE);
    // The readers' refreshes in that minute each go at once.
    const before = t.waits.length;
    const readers = await Promise.all(
      Array.from({ length: READER_TOKENS_PER_MINUTE }, () => pace.readers.take()),
    );
    expect(readers).toEqual(Array.from({ length: READER_TOKENS_PER_MINUTE }, () => 0));
    expect(t.waits).toHaveLength(before);
    await Promise.all(agents);
    // Every grant, agents' and readers', as one list: on the stopped clock a wait is its slot's time,
    // and a grant at once asks no wait. No sliding minute holds more than the run's pace.
    const total = 1000 + READER_TOKENS_PER_MINUTE;
    const granted = [...Array.from({ length: total - t.waits.length }, () => 0), ...t.waits];
    expect(busiest(granted.toSorted((a, b) => a - b))).toBe(TOKENS_PER_MINUTE);
  });

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

  it("[loadgen.pace-tokens-only] holds only the token requests to the pace, and sends one whose wait is short", async () => {
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
      Array.from({ length: 50 }, () => fetch(TOKEN, { method: "POST", body: "grant_type=x" })),
    );
    expect(t.waits).toEqual([]);
    // The minute's slots are taken: ten seconds before it ends, the next waits ten seconds and is sent.
    t.set(50_000);
    const late = await fetch(TOKEN, { method: "POST" });
    expect([late.status, t.waits]).toEqual([200, [10_000]]);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => fetch(`https://keel.test/v1/changes/c${i}`, {})),
    );
    expect(t.waits).toEqual([10_000]);
    expect(sent).toHaveLength(81);
  });

  it("[loadgen.pace-fresh] a token request held past its signature's life is answered 429 unsent, and the client's retry goes on its slot at once", async () => {
    const t = stopped();
    const pace = new Pace(50, t.clock);
    const sent: string[] = [];
    const send = async (input: string) => {
      sent.push(input);
      return ok();
    };
    const others = paced(send, pace, TOKEN);
    await Promise.all(Array.from({ length: 50 }, () => others(TOKEN, { method: "POST" })));

    // The minute's slots are taken, so this client's request waits a minute: longer than it lives.
    const fetch = paced(send, pace, TOKEN);
    const held = await fetch(TOKEN, { method: "POST" });
    expect([held.status, sent.length, pace.signedAgain, pace.refused]).toEqual([429, 50, 1, 0]);
    expect(t.waits).toEqual([MINUTE]);
    expect(MINUTE).toBeGreaterThan(FRESH_MS);

    // Its retry, signed again, goes at once on the slot it kept; another client's waits its own turn.
    const again = await fetch(TOKEN, { method: "POST" });
    expect([again.status, sent.length, t.waits]).toEqual([200, 51, [MINUTE]]);
    await others(TOKEN, { method: "POST" });
    expect(t.waits).toHaveLength(2);
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
