// Smart HTTP client pieces (gitprotocol-http, gitprotocol-pack,
// gitprotocol-common): pkt-line framing, ref advertisement, a protocol v1
// receive-pack push with report-status, and a v1 upload-pack fetch.

import { concat, dec, enc, ZERO_OID } from "./bytes";

export function pkt(line: string | Uint8Array): Uint8Array {
  const body = typeof line === "string" ? enc.encode(line) : line;
  const len = (body.length + 4).toString(16).padStart(4, "0");
  return concat([enc.encode(len), body]);
}

export const FLUSH = enc.encode("0000");

export interface Pkt {
  /** null for flush (0000) / delim (0001) / response-end (0002). */
  data: Uint8Array | null;
}

export function* readPkts(buf: Uint8Array, start = 0): Generator<Pkt & { end: number }> {
  let p = start;
  while (p + 4 <= buf.length) {
    const len = parseInt(dec.decode(buf.subarray(p, p + 4)), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${p}`);
    if (len < 4) {
      p += 4;
      yield { data: null, end: p };
      continue;
    }
    if (p + len > buf.length) throw new Error(`truncated pkt-line at ${p}`);
    const data = buf.subarray(p + 4, p + len);
    p += len;
    yield { data, end: p };
  }
}

export interface Advertisement {
  refs: Map<string, string>;
  caps: Set<string>;
  head: string | null;
}

export function parseAdvertisement(buf: Uint8Array): Advertisement {
  const refs = new Map<string, string>();
  const caps = new Set<string>();
  let first = true;
  for (const { data } of readPkts(buf)) {
    if (!data) continue;
    let line = dec.decode(data).replace(/\n$/, "");
    if (line.startsWith("# service=")) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (first) for (const c of line.slice(nul + 1).split(" ")) if (c) caps.add(c);
      line = line.slice(0, nul);
    }
    first = false;
    const [oid, name] = line.split(" ");
    if (oid && name && name !== "capabilities^{}") refs.set(name, oid);
  }
  return { refs, caps, head: refs.get("refs/heads/main") ?? null };
}

export interface Remote {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function headers(r: Remote, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${r.token}`, "User-Agent": "git/2.50.0-keel-spike", ...extra };
}

export async function advertise(r: Remote, service: "git-receive-pack" | "git-upload-pack"): Promise<Advertisement> {
  const f = r.fetchImpl ?? fetch;
  const res = await f(`${r.url}/info/refs?service=${service}`, { headers: headers(r) });
  const body = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`info/refs ${res.status}: ${dec.decode(body).slice(0, 300)}`);
  return parseAdvertisement(body);
}

export interface PushResult {
  status: number;
  unpack: string | null;
  refStatus: Map<string, { ok: boolean; reason?: string }>;
  raw: string;
}

export function parseReportStatus(buf: Uint8Array): Omit<PushResult, "status"> {
  let unpack: string | null = null;
  const refStatus = new Map<string, { ok: boolean; reason?: string }>();
  const lines: string[] = [];
  for (const { data } of readPkts(buf)) {
    if (!data) continue;
    let payload = data;
    // Tolerate side-band framing if the server applies it anyway.
    if (payload[0] === 1) payload = payload.subarray(1);
    else if (payload[0] === 2 || payload[0] === 3) {
      lines.push(dec.decode(payload.subarray(1)));
      continue;
    }
    const nested = dec.decode(payload);
    if (nested.startsWith("ERR ")) {
      // gitprotocol-pack error line: the server refused the whole request.
      lines.push(nested.replace(/\n$/, ""));
      continue;
    }
    const inner = nested.startsWith("unpack") || nested.startsWith("ok ") || nested.startsWith("ng ");
    const chunks = inner ? [payload] : [...readPkts(payload)].map((p) => p.data).filter((d): d is Uint8Array => !!d);
    for (const c of chunks) {
      const line = dec.decode(c).replace(/\n$/, "");
      lines.push(line);
      if (line.startsWith("unpack ")) unpack = line.slice(7);
      else if (line.startsWith("ok ")) refStatus.set(line.slice(3), { ok: true });
      else if (line.startsWith("ng ")) {
        const rest = line.slice(3);
        const sp = rest.indexOf(" ");
        refStatus.set(rest.slice(0, sp), { ok: false, reason: rest.slice(sp + 1) });
      }
    }
  }
  return { unpack, refStatus, raw: lines.join("\n") };
}

/** One-ref protocol v1 push. `oldOid` is the compare-and-swap expectation. */
export async function receivePack(
  r: Remote,
  ref: string,
  oldOid: string,
  newOid: string,
  pack: Uint8Array,
): Promise<PushResult> {
  const f = r.fetchImpl ?? fetch;
  const body = concat([
    pkt(`${oldOid} ${newOid} ${ref}\0report-status agent=keel-spike-13\n`),
    FLUSH,
    newOid === ZERO_OID ? new Uint8Array(0) : pack,
  ]);
  const res = await f(`${r.url}/git-receive-pack`, {
    method: "POST",
    headers: headers(r, {
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
    }),
    body,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) return { status: res.status, unpack: null, refStatus: new Map(), raw: dec.decode(buf).slice(0, 500) };
  try {
    return { status: res.status, ...parseReportStatus(buf) };
  } catch (e) {
    // Not a report-status stream: surface the bytes rather than guess.
    return { status: res.status, unpack: null, refStatus: new Map(), raw: `unparseable (${String(e)}): ${JSON.stringify(dec.decode(buf).slice(0, 300))}` };
  }
}

/** Protocol v1 fetch of everything reachable from `wants`; returns the raw pack. */
export async function uploadPack(r: Remote, wants: string[], caps: Set<string>): Promise<Uint8Array> {
  const f = r.fetchImpl ?? fetch;
  const ask = ["ofs-delta", "no-progress", "agent=keel-spike-13"];
  const sideband = caps.has("side-band-64k");
  if (sideband) ask.unshift("side-band-64k");
  const lines = wants.map((w, i) => pkt(i === 0 ? `want ${w} ${ask.join(" ")}\n` : `want ${w}\n`));
  const body = concat([...lines, FLUSH, pkt("done\n")]);
  const res = await f(`${r.url}/git-upload-pack`, {
    method: "POST",
    headers: headers(r, {
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
    }),
    body,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`upload-pack ${res.status}: ${dec.decode(buf).slice(0, 300)}`);
  // Skip acknowledgement lines (NAK / ACK) up to the pack.
  let p = 0;
  const parts: Uint8Array[] = [];
  for (const pk of readPkts(buf)) {
    p = pk.end;
    if (!pk.data) {
      if (sideband) break;
      continue;
    }
    if (!sideband) {
      const s = dec.decode(pk.data.subarray(0, 4));
      if (s === "NAK\n" || s.startsWith("ACK")) {
        if (s === "NAK\n") break;
        continue;
      }
    } else {
      const band = pk.data[0];
      if (band === 1) parts.push(pk.data.subarray(1));
      else if (band === 3) throw new Error(`upload-pack error: ${dec.decode(pk.data.subarray(1))}`);
      else if (band !== 2) {
        const s = dec.decode(pk.data);
        if (!s.startsWith("NAK") && !s.startsWith("ACK")) throw new Error(`unexpected pkt ${JSON.stringify(s)}`);
      }
    }
  }
  return sideband ? concat(parts) : buf.subarray(p);
}
