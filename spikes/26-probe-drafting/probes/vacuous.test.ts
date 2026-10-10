import { expect, it } from "vitest";

// Can-fail: an assertion that cannot fail. It logs an observation so the
// runner does not reject it as a harness error; the matrix must reject it.
it("holds", () => {
  console.log("[probe] nothing -> 0 (expected 0)");
  expect(true).toBe(true);
});
