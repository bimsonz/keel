// Memory probe: grow linear memory in steps and touch every page until
// memory.grow fails, the target is reached, or the isolate is killed.
// keep=1 holds the instance at module scope so the memory outlives the request;
// `invocation` counts requests this isolate has served (1 = fresh isolate).
import { serve } from "./common.ts";
import wasm from "./memgrow.wasm";

const PAGE = 65536;
let invocation = 0;
let kept: WebAssembly.Instance | undefined;
const hold: unknown[] = [];

export default serve("memgrow", (_input, url) => {
  invocation++;
  const stepMb = Number(url.searchParams.get("stepMb") ?? "16");
  const targetMb = Number(url.searchParams.get("targetMb") ?? "256");
  const keep = url.searchParams.get("keep") === "1";
  const instance = keep ? (kept ??= new WebAssembly.Instance(wasm, {})) : new WebAssembly.Instance(wasm, {});
  const grow = instance.exports.grow as (pages: number) => number;
  const touch = instance.exports.touch as (from: number, to: number) => void;
  const memory = instance.exports.memory as WebAssembly.Memory;
  const startMb = memory.buffer.byteLength / 1048576;
  const steps: Array<{ mb: number; ok: boolean }> = [];
  const pagesPerStep = (stepMb * 1024 * 1024) / PAGE;
  while (memory.buffer.byteLength < targetMb * 1024 * 1024) {
    const before = memory.buffer.byteLength;
    let ok: boolean;
    try {
      ok = grow(pagesPerStep) !== -1;
    } catch {
      ok = false;
    }
    if (!ok) {
      steps.push({ mb: before / 1048576 + stepMb, ok: false });
      break;
    }
    // Byte offsets are i32 in the module; stop touching past 2 GiB.
    const to = Math.min(memory.buffer.byteLength, 0x7fff0000);
    if (before < to) touch(before, to);
    steps.push({ mb: memory.buffer.byteLength / 1048576, ok: true });
  }
  // instances=N: grow N-1 further, independent memories to targetMb each (all held
  // until the request ends). jsMb=N: allocate N MiB of plain JS heap objects.
  const extra = Number(url.searchParams.get("instances") ?? "1") - 1;
  const extraMb: number[] = [];
  for (let i = 0; i < extra; i++) {
    const inst = new WebAssembly.Instance(wasm, {});
    const mem = inst.exports.memory as WebAssembly.Memory;
    while (mem.buffer.byteLength < targetMb * 1024 * 1024) {
      const before = mem.buffer.byteLength;
      if ((inst.exports.grow as (p: number) => number)(pagesPerStep) === -1) break;
      (inst.exports.touch as (a: number, b: number) => void)(before, mem.buffer.byteLength);
    }
    extraMb.push(mem.buffer.byteLength / 1048576);
    hold.push(inst);
  }
  const jsMb = Number(url.searchParams.get("jsMb") ?? "0");
  let jsAllocatedMb = 0;
  for (let i = 0; i < jsMb; i++) {
    // ~1 MiB of heap per step: 1 Ki objects holding a 64-element number array each.
    const chunk: number[][] = [];
    for (let j = 0; j < 1024; j++) chunk.push(Array.from({ length: 64 }, (_, k) => k + j + i + 0.5));
    hold.push(chunk);
    jsAllocatedMb++;
  }
  const failed = steps.find((s) => !s.ok);
  return {
    extraInstancesMb: extraMb,
    jsAllocatedMb,
    invocation,
    keep,
    startMb,
    finalMb: memory.buffer.byteLength / 1048576,
    firstFailedGrowAtMb: failed?.mb ?? null,
    steps: steps.length,
  };
});
