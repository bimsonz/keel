import { describe, expect, it } from "vitest";
import { jsChunks } from "./alloc.ts";

// Five tests, 50 MiB each, all retained: 250 MiB live by the last test.
const kept: unknown[] = [];
describe("js several allocations", () => {
  for (let i = 1; i <= 5; i++) {
    it(`retains chunk ${i} (50 MiB)`, () => {
      kept.push(jsChunks(50));
      expect(kept.length).toBe(i);
    });
  }
});
