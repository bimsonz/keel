import { describe, expect, it } from "vitest";
import { arrayBuffer } from "./alloc.ts";

const kept: unknown[] = [];
describe("ab several allocations", () => {
  for (let i = 1; i <= 5; i++) {
    it(`retains buffer ${i} (50 MiB)`, () => {
      kept.push(arrayBuffer(50));
      expect(kept.length).toBe(i);
    });
  }
});
