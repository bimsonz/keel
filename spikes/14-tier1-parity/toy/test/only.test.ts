import { describe, it, expect } from "vitest";

describe("only within a file", () => {
  it.only("runs", () => {
    expect(1 + 1).toBe(2);
  });
  it("is skipped because another test is .only", () => {
    expect(1).toBe(2);
  });
});
