// A protocol v1 upload-pack fetch over smart HTTP (gitprotocol-http,
// gitprotocol-pack), and a relay that feeds the fetched pack, unread, to
// another repo's receive-pack. Relaying the server's own pack keeps every
// object byte for byte, so commit ids survive the copy; rebuilding commits
// from decoded metadata would not.

import { concat, dec, ZERO_OID } from "./bytes.ts";
import { FLUSH, type GitRemote, type PushOutcome, pkt, readPkts, receivePack } from "./push.ts";

/** The most a relay sends in one receive-pack request: Artifacts caps a request at about 64 MiB (spike S3). */
export const MAX_RELAY_PACK_BYTES = 60 * 1024 * 1024;

/**
 * A relayed pack over the cap. Known limit until the pack can be split: it
 * fails loudly, never truncates. `bytes` is what was read before giving up,
 * which is at least the cap.
 */
export class PackTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`the relayed pack is over the ${limit}-byte receive-pack cap (${bytes} bytes read)`);
  }
}

/** Side-band framing and acknowledgements around a pack of `limit` bytes: 5 bytes per 65,515, and a margin. */
const framing = (limit: number) => Math.ceil(limit / 65_515) * 5 + 65_536;

/** receive-pack answered `busy` on every attempt: nothing was applied, and the same pack may be sent again later. */
export class ReceivePackBusy extends Error {
  constructor(readonly attempts: number) {
    super(`receive-pack stayed busy after ${attempts} attempts`);
  }
}

/**
 * Fetches the pack of everything reachable from `wants` that is not reachable
 * from `haves`. The answer is the raw pack (`PACK…`), demultiplexed from
 * side-band-64k; an error band or an HTTP error throws, never naming the remote.
 * The answer is read as it streams: past `maxBytes` (and its framing) the read
 * stops and PackTooLarge is thrown, so a pack over the cap is never held whole.
 */
export async function uploadPack(
  remote: GitRemote,
  wants: readonly string[],
  haves: readonly string[],
  options: { readonly maxBytes?: number } = {},
): Promise<Uint8Array> {
  if (wants.length === 0) throw new Error("a fetch needs at least one want");
  const caps = ["side-band-64k", "ofs-delta", "no-progress", "agent=keel-gitcore"].join(" ");
  const body = concat([
    ...wants.map((w, i) => pkt(i === 0 ? `want ${w} ${caps}\n` : `want ${w}\n`)),
    FLUSH,
    ...haves.map((h) => pkt(`have ${h}\n`)),
    pkt("done\n"),
  ]);
  const f = remote.fetch ?? fetch;
  const res = await f(`${remote.url}/git-upload-pack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${remote.token}`,
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
    },
    body,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`upload-pack answered HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("upload-pack answered without a body");
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    read += next.value.length;
    if (read > limit + framing(limit)) {
      await reader.cancel();
      throw new PackTooLarge(read, limit);
    }
    chunks.push(next.value);
  }
  const answer = concat(chunks);
  const pack: Uint8Array[] = [];
  for (const line of readPkts(answer)) {
    if (line === null) break;
    const band = line[0];
    if (band === 1) pack.push(line.subarray(1));
    else if (band === 3) throw new Error(`upload-pack error: ${dec.decode(line.subarray(1))}`);
    else if (band !== 2) {
      // Acknowledgements arrive outside the bands, before the pack.
      const text = dec.decode(line);
      if (!text.startsWith("NAK") && !text.startsWith("ACK"))
        throw new Error(`unexpected upload-pack line ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  const bytes = concat(pack);
  if (dec.decode(bytes.subarray(0, 4)) !== "PACK")
    throw new Error("upload-pack answered without a pack");
  return bytes;
}

/** One ref to copy: it holds `from` in the target now (null: absent), and should hold `to`, the source's head. */
export interface RelayMove {
  readonly ref: string;
  readonly from: string | null;
  readonly to: string;
  /**
   * Commits the target already holds, so the pack carries only what is past
   * them; `[from]` when omitted. A new ref (`from` null) in a repo that holds
   * the history names it here, or the whole history is sent.
   */
  readonly haves?: readonly string[];
}

/**
 * - `unchanged`: the target already held the source's head; nothing was sent;
 * - `advanced`: the target's ref moved to the source's head;
 * - `rejected`: the target's ref no longer held `from` (or the pack failed); re-read it and relay again.
 */
export type RelayOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "advanced" }
  | { readonly kind: "rejected"; readonly outcome: Extract<PushOutcome, { kind: "rejected" }> };

export interface RelayOptions {
  readonly maxPackBytes?: number;
  /** Receive-pack requests answered `busy` are retried this many times. */
  readonly busyRetries?: number;
}

/**
 * The pack a relay of `move` sends: what `move.to` reaches in `source` past
 * the move's haves (`[from]` unless it names its own). Its length is what the
 * target's repo takes in, and it is compared with the cap exactly: the room
 * the streamed read leaves for side-band framing never lets a pack over the
 * cap through. Over it throws `PackTooLarge`.
 */
export async function relayPack(
  source: GitRemote,
  move: RelayMove,
  options: Pick<RelayOptions, "maxPackBytes"> = {},
): Promise<Uint8Array> {
  const limit = options.maxPackBytes ?? MAX_RELAY_PACK_BYTES;
  const haves = move.haves ?? (move.from === null ? [] : [move.from]);
  const pack = await uploadPack(source, [move.to], haves, { maxBytes: limit });
  if (pack.length > limit) throw new PackTooLarge(pack.length, limit);
  return pack;
}

/**
 * Copies `move.to` from `source` into `target`'s `move.ref`: fetches the pack
 * of what the target lacks (have = `from`) and pushes it with `from` as the
 * explicit old value (zero for an empty target), so a target that moved
 * meanwhile refuses it. A pack over the cap throws `PackTooLarge`, and a
 * target still busy after the retries `ReceivePackBusy`.
 */
export async function relay(
  source: GitRemote,
  target: GitRemote,
  move: RelayMove,
  options: RelayOptions = {},
): Promise<RelayOutcome> {
  if (move.from === move.to) return { kind: "unchanged" };
  const pack = await relayPack(source, move, options);
  const update = { ref: move.ref, old: move.from ?? ZERO_OID, new: move.to };
  const retries = options.busyRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await receivePack(target, [update], pack);
    switch (outcome.kind) {
      case "applied":
        return { kind: "advanced" };
      case "rejected":
        return { kind: "rejected", outcome };
      case "busy":
        if (attempt >= retries) throw new ReceivePackBusy(retries + 1);
        // Another push holds the repo: back off briefly, then send the same pack again.
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        continue;
      case "failed":
        throw new Error(outcome.message);
    }
  }
}
