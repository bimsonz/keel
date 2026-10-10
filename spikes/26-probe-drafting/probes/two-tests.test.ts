import { expect, it } from "vitest";

// Can-fail for the runner's harness errors: a probe file must hold exactly one test.
it("first", () => {
  console.log("[probe] first -> 1 (expected 1)");
  expect(1).toBe(1);
});
it("second", () => {
  expect(2).toBe(2);
});
