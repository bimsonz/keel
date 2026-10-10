// Allocation helpers for the memory cases. Every helper touches what it
// allocates so the pages are committed, and returns it so it stays live.
export const MiB = 1024 * 1024;

/** One JS array of doubles: a single large heap allocation. */
export function jsArray(mib: number): number[] {
  return new Array<number>((mib * MiB) / 8).fill(0.5);
}

/** Many 1 MiB JS arrays of doubles. */
export function jsChunks(mib: number): number[][] {
  return Array.from({ length: mib }, (_, i) => new Array<number>(MiB / 8).fill(i + 0.5));
}

/** One ArrayBuffer (off-heap backing store). */
export function arrayBuffer(mib: number): Uint8Array {
  return new Uint8Array(mib * MiB).fill(1);
}

/** One WebAssembly.Memory grown in a single step. */
export function wasmMemory(mib: number): WebAssembly.Memory {
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
  mem.grow((mib * MiB) / 65536 - 1);
  new Uint8Array(mem.buffer).fill(1);
  return mem;
}
