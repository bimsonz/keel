import { describe, expect, it } from "vitest";
import { MiB } from "./alloc.ts";

// One memory grown 50 MiB at a time, five times: 250 MiB.
const mem = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
describe("wasm several grows", () => {
  for (let i = 1; i <= 5; i++) {
    it(`grows by 50 MiB (step ${i})`, () => {
      mem.grow((50 * MiB) / 65536);
      new Uint8Array(mem.buffer).fill(1);
      expect(mem.buffer.byteLength).toBeGreaterThan(i * 50 * MiB);
    });
  }
});
