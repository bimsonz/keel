// Pack v2 reader. Each object's data is a zlib stream with no length prefix,
// so the reader has to learn how many input bytes each stream consumed to find
// the next object. pako's Inflate exposes that through its ZStream; the
// platform DecompressionStream does not (and on workerd it rejects the
// trailing bytes outright).

import { Inflate, type ZStream } from "pako";
import { concat, enc, equalBytes, sha1, toHex } from "./bytes";
import type { ObjectType } from "./objects";

const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export interface PackObject {
  offset: number;
  type: ObjectType;
  oid: string;
  body: Uint8Array;
}

export interface PackReadResult {
  declaredCount: number;
  objects: PackObject[];
  deltas: number;
  trailerOk: boolean;
}

/** Inflate one zlib stream starting at `start`; returns output and bytes consumed. */
export function inflateAt(pack: Uint8Array, start: number, expectedSize: number): { out: Uint8Array; used: number } {
  const inflator = new Inflate();
  let strm: ZStream | undefined;
  inflator.onStart = (s: ZStream) => {
    strm = s;
  };
  const input = pack.subarray(start);
  inflator.push(input, false);
  if (!inflator.ended) inflator.push(new Uint8Array(0), true);
  if (inflator.err) throw new Error(`inflate failed at ${start}: ${inflator.msg}`);
  if (!strm) throw new Error("inflate never started");
  // The stream object's input cursor stops right after the zlib trailer.
  const used = strm.next_in;
  const out = inflator.result ?? concat(inflator.chunks);
  if (out.length !== expectedSize) throw new Error(`size mismatch at ${start}: ${out.length} != ${expectedSize}`);
  return { out, used };
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let shift = 0;
  let value = 0;
  for (;;) {
    const b = buf[pos++] as number;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) return [value, pos];
  }
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let [srcSize, p] = readVarint(delta, 0);
  if (srcSize !== base.length) throw new Error(`delta base size ${srcSize} != ${base.length}`);
  let dstSize: number;
  [dstSize, p] = readVarint(delta, p);
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++] as number;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= (delta[p++] as number) << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= (delta[p++] as number) << (8 * i);
      off >>>= 0;
      if (size === 0) size = 0x10000;
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op > 0) {
      out.set(delta.subarray(p, p + op), o);
      o += op;
      p += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  if (o !== dstSize) throw new Error(`delta produced ${o} != ${dstSize}`);
  return out;
}

export async function readPack(pack: Uint8Array): Promise<PackReadResult> {
  if (toHex(pack.subarray(0, 4)) !== "5041434b") throw new Error("not a pack");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = view.getUint32(8);
  const trailerOk = equalBytes(
    new Uint8Array(await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.length - 20) as Uint8Array<ArrayBuffer>)),
    pack.subarray(pack.length - 20),
  );

  interface Raw {
    offset: number;
    kind: number;
    data: Uint8Array;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  let pos = 12;
  for (let i = 0; i < declaredCount; i++) {
    const offset = pos;
    let c = pack[pos++] as number;
    const kind = (c >> 4) & 7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) {
      c = pack[pos++] as number;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const raw: Raw = { offset, kind, data: new Uint8Array(0) };
    if (kind === OFS_DELTA) {
      c = pack[pos++] as number;
      let back = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++] as number;
        back = (back + 1) * 128 + (c & 0x7f);
      }
      raw.baseOffset = offset - back;
    } else if (kind === REF_DELTA) {
      raw.baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!TYPES[kind]) {
      throw new Error(`bad object type ${kind} at ${offset}`);
    }
    const { out, used } = inflateAt(pack, pos, size);
    raw.data = out;
    pos += used;
    raws.push(raw);
  }
  if (pos !== pack.length - 20) throw new Error(`pack has ${pack.length - 20 - pos} unexplained bytes`);

  const byOffset = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();
  const objects: PackObject[] = [];
  let pending = raws;
  let deltas = 0;
  while (pending.length > 0) {
    const next: Raw[] = [];
    for (const raw of pending) {
      let type: ObjectType;
      let body: Uint8Array;
      if (raw.kind === OFS_DELTA || raw.kind === REF_DELTA) {
        const base = raw.baseOffset !== undefined ? byOffset.get(raw.baseOffset) : byOid.get(raw.baseOid as string);
        if (!base) {
          next.push(raw);
          continue;
        }
        type = base.type;
        body = applyDelta(base.body, raw.data);
        deltas++;
      } else {
        type = TYPES[raw.kind] as ObjectType;
        body = raw.data;
      }
      const oid = await sha1(concat([enc.encode(`${type} ${body.length}\0`), body]));
      const obj = { offset: raw.offset, type, oid, body };
      byOffset.set(raw.offset, obj);
      byOid.set(oid, obj);
      objects.push(obj);
    }
    if (next.length === pending.length) throw new Error(`${next.length} deltas with missing bases (thin pack?)`);
    pending = next;
  }
  return { declaredCount, objects, deltas, trailerOk };
}
