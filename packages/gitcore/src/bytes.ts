// Small byte helpers shared by the object, pack and protocol code.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) throw new Error(`bad hex: ${h}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha1(data: Uint8Array): Promise<string> {
  // subtle.digest wants bytes over a plain ArrayBuffer; copy only when they sit on something else.
  const view =
    data.buffer instanceof ArrayBuffer
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  const d = await crypto.subtle.digest("SHA-1", view);
  return toHex(new Uint8Array(d));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const ZERO_OID = "0".repeat(40);
