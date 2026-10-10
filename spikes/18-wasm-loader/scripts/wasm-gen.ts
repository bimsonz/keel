// Hand-assembles small, valid WebAssembly modules for the size-ceiling and
// memory probes. No toolchain: every section is encoded here.
//
// padded(active):  memory sized to hold the payload, one ACTIVE data segment
//                  copied into linear memory at instantiation. Exports
//                  probe() -> i32 = last 4 payload bytes read from memory.
// padded(passive): one PASSIVE data segment (bulk-memory), memory of 1 page.
//                  The payload lives in the module bytes only. probe() -> 42.
// memgrow:         memory min 1 page, max 65536 pages. Exports grow(pages)
//                  -> old size or -1, and touch(from, to) which writes one i32
//                  every 4 KiB in [from, to) so the pages are really committed.
// tiny:            one function answer() -> 42. Used as raw bytes by the
//                  runtime-compile probe.

const u32 = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};

const i32const = (n: number): number[] => {
  // signed LEB128
  const out: number[] = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return [0x41, ...out];
};

const name = (s: string): number[] => {
  const b = [...new TextEncoder().encode(s)];
  return [...u32(b.length), ...b];
};

const vec = (items: number[][]): number[] => [...u32(items.length), ...items.flat()];

const section = (id: number, body: number[]): Uint8Array => {
  const head = [id, ...u32(body.length)];
  return Uint8Array.from([...head, ...body]);
};

const HEADER = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const I32 = 0x7f;
const FUNC = 0x60;

const concat = (parts: Uint8Array[]): Uint8Array => {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const body = (locals: number[][], code: number[]): number[] => {
  const b = [...vec(locals), ...code, 0x0b];
  return [...u32(b.length), ...b];
};

/** Deterministic, incompressible filler (xorshift32), so sizes mean bytes on the wire. */
export function filler(len: number, seed = 0x5eed1234): Uint8Array {
  const out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  let x = seed >>> 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    view.setUint32(i, x, true);
  }
  for (; i < len; i++) out[i] = i & 0xff;
  return out;
}

export function padded(totalBytes: number, mode: "active" | "passive"): Uint8Array {
  // Everything except the payload is well under 200 bytes; aim the file at totalBytes.
  const payloadLen = Math.max(4, totalBytes - 128);
  const payload = filler(payloadLen);
  const pages = mode === "active" ? Math.ceil(payloadLen / 65536) + 1 : 1;

  const types = section(1, vec([[FUNC, 0, 1, I32]]));
  const funcs = section(3, vec([[0]]));
  const memory = section(5, vec([[0x00, ...u32(pages)]]));
  const exports = section(
    7,
    vec([
      [...name("memory"), 0x02, 0],
      [...name("probe"), 0x00, 0],
    ]),
  );
  const probeCode =
    mode === "active"
      ? [...i32const(payloadLen - 4), 0x28, 0x02, 0x00] // i32.load align=2 offset=0
      : [...i32const(42)];
  const code = section(10, vec([body([], probeCode)]));
  const segment =
    mode === "active"
      ? [0x00, ...i32const(0), 0x0b, ...u32(payloadLen)]
      : [0x01, ...u32(payloadLen)];
  const dataHead = [...u32(1), ...segment];
  const dataSection = concat([
    Uint8Array.from([11, ...u32(dataHead.length + payloadLen), ...dataHead]),
    payload,
  ]);
  return concat([HEADER, types, funcs, memory, exports, code, dataSection]);
}

/** The value probe() must return for an active module of totalBytes. */
export function expectedProbe(totalBytes: number): number {
  const payloadLen = Math.max(4, totalBytes - 128);
  const p = filler(payloadLen);
  return new DataView(p.buffer).getInt32(payloadLen - 4, true);
}

export function memgrow(): Uint8Array {
  const types = section(
    1,
    vec([
      [FUNC, 1, I32, 1, I32], // grow(i32) -> i32
      [FUNC, 2, I32, I32, 0], // touch(i32, i32)
    ]),
  );
  const funcs = section(3, vec([[0], [1]]));
  const memory = section(5, vec([[0x01, ...u32(1), ...u32(65536)]]));
  const exports = section(
    7,
    vec([
      [...name("memory"), 0x02, 0],
      [...name("grow"), 0x00, 0],
      [...name("touch"), 0x00, 1],
    ]),
  );
  const grow = [0x20, 0, 0x40, 0x00]; // local.get 0; memory.grow 0
  // local $i = from; block; loop; if i >= to br 1; store i at i; i += 4096; br 0; end; end
  const touch = [
    0x20, 0, 0x21, 2,
    0x02, 0x40,
    0x03, 0x40,
    0x20, 2, 0x20, 1, 0x4f, 0x0d, 1,
    0x20, 2, 0x20, 2, 0x36, 0x02, 0x00,
    0x20, 2, ...i32const(4096), 0x6a, 0x21, 2,
    0x0c, 0,
    0x0b,
    0x0b,
  ];
  const code = section(10, vec([body([], grow), body([[1, I32]], touch)]));
  return concat([HEADER, types, funcs, memory, exports, code]);
}

export function tiny(): Uint8Array {
  const types = section(1, vec([[FUNC, 0, 1, I32]]));
  const funcs = section(3, vec([[0]]));
  const exports = section(7, vec([[...name("answer"), 0x00, 0]]));
  const code = section(10, vec([body([], i32const(42))]));
  return concat([HEADER, types, funcs, exports, code]);
}
