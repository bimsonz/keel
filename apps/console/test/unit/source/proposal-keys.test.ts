// A page's proposals each carry one Idempotency-Key: asking again for the same
// commit and goal is the same request, so a retry after a busy pool reaches the
// reservation the first attempt made instead of holding a second place.
import { describe, expect, it } from "vitest";
import { proposalKeys } from "../../../src/source/http.ts";

describe("a page's proposal keys", () => {
  it("[proposal-keys.one-per-body] the same commit and goal asked again carry the key they first had; another commit or goal carries its own", () => {
    const keyOf = proposalKeys();
    const first = keyOf({ commit: "a".repeat(40), goal: "Retry a refused push" });
    expect(keyOf({ commit: "a".repeat(40), goal: "Retry a refused push" })).toBe(first);
    const others = [
      keyOf({ commit: "b".repeat(40), goal: "Retry a refused push" }),
      keyOf({ commit: "a".repeat(40), goal: "Retry it twice" }),
    ];
    expect(new Set([first, ...others]).size).toBe(3);
    expect(first).toMatch(/^console:propose:/);
  });
});
