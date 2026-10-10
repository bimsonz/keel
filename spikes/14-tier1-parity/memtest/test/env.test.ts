import { expect, it } from "vitest";
import { arrayBuffer, jsArray, wasmMemory } from "./alloc.ts";

// Reports which memory introspection hooks exist in the runtime, and whether
// process.memoryUsage() (if present) moves when memory is allocated.
it("reports memory hooks", () => {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
  const g = globalThis as unknown as { process?: { memoryUsage?: () => Record<string, number> }; gc?: unknown };
  const usage = () => (g.process?.memoryUsage ? g.process.memoryUsage() : null);
  const before = usage();
  const keep: unknown[] = [jsArray(64)];
  const afterJs = usage();
  keep.push(arrayBuffer(64));
  const afterAb = usage();
  keep.push(wasmMemory(64));
  const afterWasm = usage();
  const report = {
    performanceMemory: typeof perf.memory,
    processMemoryUsage: typeof g.process?.memoryUsage,
    gc: typeof g.gc,
    before,
    afterJs,
    afterAb,
    afterWasm,
  };
  console.log(`[env] ${JSON.stringify(report)}`);
  expect(keep.length).toBe(3);
});
