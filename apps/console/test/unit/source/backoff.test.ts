import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, retryAfterOf, retryable } from "../../../src/source/backoff.ts";
import { refusalOf } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The lowest and the highest jitter. */
const low = (): number => 0;
const high = (): number => 1;

/** Keel's problem answer to a read while it is away, with the headers and fields a test gives it. */
const problem = (headers: Record<string, string>, body: object = {}): Response =>
  Response.json(
    { title: "service.unavailable", code: "service.unavailable", ...body },
    { status: 503, headers },
  );

const away = (retryAfterMs?: number): KeelRefused =>
  new KeelRefused("The database is away", "service.unavailable", 503, [], retryAfterMs);

describe("asking Keel again", () => {
  it("[backoff.rule] waits later each time, with jitter, up to thirty seconds, and never sooner than Keel asked", () => {
    // Doubling from a second, each wait somewhere in its upper half.
    expect(
      [1, 2, 3, 4, 5].map((failures) => backoffMs(new Error("dropped"), failures, low)),
    ).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    expect(
      [1, 2, 3, 4, 5].map((failures) => backoffMs(new Error("dropped"), failures, high)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    // Thirty seconds at most, however long it has failed.
    expect(backoffMs(new Error("dropped"), 6, high)).toBe(30_000);
    expect(backoffMs(new Error("dropped"), 40, high)).toBe(30_000);
    expect(backoffMs(new Error("dropped"), 40, low)).toBe(15_000);
    // Keel's Retry-After is the least it waits; a longer one of its own reckoning stands.
    expect(backoffMs(away(5_000), 1, high)).toBe(5_000);
    expect(backoffMs(away(5_000), 5, high)).toBe(16_000);
    // A Retry-After past five minutes is taken at five.
    expect(backoffMs(away(60 * 60_000), 1, low)).toBe(5 * 60_000);

    // Keel away, too busy or too slow is asked again; a dropped read too. Any other refusal is Keel's answer.
    expect(retryable(away())).toBe(true);
    expect(retryable(new KeelRefused("Slow down", "rate.limited", 429))).toBe(true);
    expect(retryable(new KeelRefused("Timed out", "request.timeout", 408))).toBe(true);
    expect(retryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(retryable(new KeelRefused("Not found", "resource.not_found", 404))).toBe(false);
    expect(retryable(new KeelRefused("Sign in", "auth.required", 401))).toBe(false);
    expect(retryable(new DOMException("The page was left", "AbortError"))).toBe(false);
  });

  it("[http.retry-after] reads when Keel asked to be asked again into its refusal: the header, a date, or the problem's own", async () => {
    const header = await refusalOf(problem({ "retry-after": "2" }));
    expect(header).toMatchObject({ status: 503, code: "service.unavailable", retryAfterMs: 2_000 });
    expect((await refusalOf(problem({}, { retryAfterMs: 1_500 }))).retryAfterMs).toBe(1_500);
    expect((await refusalOf(problem({}))).retryAfterMs).toBeUndefined();
    const now = Date.parse("2026-10-15T09:00:00Z");
    expect(retryAfterOf("Thu, 15 Oct 2026 09:00:07 GMT", {}, now)).toBe(7_000);
    expect(retryAfterOf("soon", { retryAfterMs: "later" }, now)).toBeUndefined();
  });
});

/** The fixtures' own project, with its log's reads answered by `answer` while it says so. */
function playerReading(answer: (asked: number) => Promise<never> | undefined) {
  const source = createMockSource({ scenario: "s1", seed: 42 });
  let asked = 0;
  const reading = {
    ...source,
    readEvents: (request: Parameters<typeof source.readEvents>[0]) => {
      asked += 1;
      return answer(asked) ?? source.readEvents(request);
    },
  };
  return { player: showing(reading), asked: () => asked };
}

describe("the log while Keel is away", () => {
  it("[player.follow-backoff] asks the tail again a few times a minute while Keel answers 503, not once a second", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { player, asked } = playerReading(() => Promise.reject(away(2_000)));
    const stop = new AbortController();
    const following = player.follow(stop.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    // Waits of 2, 2, 2, 4, 8, 15 and 15 s: eight reads in the minute, where a second's wait would have made sixty.
    expect(asked()).toBe(8);
    stop.abort();
    await following;
  });

  it("[player.drain-retries] reads its log through a 503 on its first page, and fails at once on a refusal", async () => {
    vi.useFakeTimers();
    const { player, asked } = playerReading((n) =>
      n === 1 ? Promise.reject(away(2_000)) : undefined,
    );
    const loading = player.load();
    await vi.advanceTimersByTimeAsync(5_000);
    await loading;
    expect(player.loaded).toBe(true);
    expect(player.end).toBeGreaterThan(0);
    expect(asked()).toBeGreaterThan(1);

    const refused = playerReading(() =>
      Promise.reject(new KeelRefused("Not found", "resource.not_found", 404)),
    );
    await expect(refused.player.load()).rejects.toMatchObject({ status: 404 });
    expect(refused.asked()).toBe(1);
  });
});
