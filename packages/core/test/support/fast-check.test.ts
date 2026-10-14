import { expect, it } from "vitest";
import { fc } from "./fast-check.ts";

/** The first value a property draws from `fc.nat()`. */
const firstDrawn = (): number | undefined => {
  let drawn: number | undefined;
  fc.assert(
    fc.property(fc.nat(), (n) => {
      drawn ??= n;
    }),
    { numRuns: 1 },
  );
  return drawn;
};

it("[fast-check.one-seed] every property in a file draws from one seed, so two properties draw the same plans", () => {
  expect(Number.isInteger(fc.readConfigureGlobal().seed)).toBe(true);
  expect(firstDrawn()).toBe(firstDrawn());
});
