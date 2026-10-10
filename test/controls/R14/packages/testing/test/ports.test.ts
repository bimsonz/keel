// Control for R14: a vacuous assertion, and a focused test.
import { expect, it } from "vitest";

it.only("can never fail", () => {
  expect(1).toBe(1);
  expect("ok").toEqual(`ok`);
});
