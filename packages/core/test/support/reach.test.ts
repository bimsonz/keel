import { describe, expect, it } from "vitest";
import { fc } from "./fast-check.ts";
import { assertReaching } from "./reach.ts";

/** Every value a property asserted with `assertReaching` was given, in order. */
const drawn = (): readonly number[] => {
  const seen: number[] = [];
  assertReaching(
    fc.property(fc.nat(), (n) => {
      seen.push(n);
      return true;
    }),
  );
  return seen;
};

describe("assertReaching", () => {
  it("[reach.floor] a property is asserted over its run's draws and then over 300 that are the same on every run", () => {
    const [first, second] = [drawn(), drawn()];
    const fixed = first.slice(-300);
    expect(second.slice(-300)).toEqual(fixed);
    // They are no copy of the run's own draws: under a seeded run those repeat too.
    expect(first.slice(0, -300)).not.toEqual(fixed);
    expect(first.length).toBeGreaterThan(300);
    expect(new Set(fixed).size).toBeGreaterThan(100);
  });
});
