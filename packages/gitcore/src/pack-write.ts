// Pack v2 writer (gitformat-pack): "PACK", version 2, object count, then per
// object a type+size varint header and a zlib stream, then a SHA-1 trailer.
// Only whole objects are written; no deltas.

import { concat, fromHex, sha1 } from "./bytes.ts";
import type { GitObject, ObjectType } from "./objects.ts";

export const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function objectHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return new Uint8Array(out);
}

/** zlib-wrapped deflate via the platform CompressionStream. */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function writePack(objects: readonly GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(header.buffer).setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const o of objects) {
    parts.push(objectHeader(TYPE_CODE[o.type], o.body.length), await zlibDeflate(o.body));
  }
  const body = concat(parts);
  return concat([body, fromHex(await sha1(body))]);
}
