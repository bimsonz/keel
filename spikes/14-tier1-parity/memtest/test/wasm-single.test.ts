import { describe, expect, it } from "vitest";
import { MiB, wasmMemory } from "./alloc.ts";

describe("wasm single allocation", () => {
  it("allocates 200 MiB in one wasmMemory call", () => {
    const x = wasmMemory(200);
    const bytes = "byteLength" in x ? (x as { byteLength: number }).byteLength : x instanceof WebAssembly.Memory ? x.buffer.byteLength : (x as unknown[]).length * 8;
    expect(bytes).toBeGreaterThanOrEqual(200 * MiB);
  });
  it("runs after the allocation", () => {
    expect(1 + 1).toBe(2);
  });
});
