import { describe, expect, it } from "vitest";
import { jsChunks } from "./alloc.ts";

// Eight tests, 100 MiB each, all retained: 800 MiB live by the last test.
const kept: unknown[] = [];
describe("js several large allocations", () => {
  for (let i = 1; i <= 8; i++) {
    it(`retains chunk ${i} (100 MiB)`, () => {
      kept.push(jsChunks(100));
      expect(kept.length).toBe(i);
    });
  }
});
