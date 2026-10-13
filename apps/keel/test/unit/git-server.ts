// A recording smart-HTTP git server for adapter tests in apps/keel, whose
// node tests cannot spawn git: upload-pack answers with a fixed pack,
// receive-pack with scripted report-status replies, and every request is
// recorded with its pkt-lines, so a test sees exactly what an adapter asked.
import { concat, dec, FLUSH, pkt, readPkts } from "@keeltown/gitcore";

/** A pack's header alone, counting one object as a forward move's pack does: no adapter reads past it. */
export const PACK = concat([
  new TextEncoder().encode("PACK"),
  new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1]),
]);

/** An empty pack, the header and no objects: what a server sends for a head its haves already reach. */
export const EMPTY_PACK = concat([
  new TextEncoder().encode("PACK"),
  new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0]),
]);

export type Reply = "ok" | "stale" | "busy";

export interface GitRequest {
  readonly service: "upload-pack" | "receive-pack";
  readonly repo: string;
  readonly auth: string | null;
  readonly lines: readonly string[];
}

/** Where a receive-pack request's commands end and its raw pack begins: just past the first flush. */
function packStart(body: Uint8Array): number {
  let at = 0;
  for (;;) {
    const length = Number.parseInt(dec.decode(body.subarray(at, at + 4)), 16);
    if (length === 0) return at + 4;
    at += length;
  }
}

/**
 * A git server that answers upload-pack with `pack` and receive-pack with each
 * scripted reply in turn, for the ref pushed. `received` holds the byte length
 * of the pack each receive-pack request carried.
 */
export function gitServer(replies: Reply[], pack: Uint8Array = PACK) {
  const requests: GitRequest[] = [];
  const received: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const service = url.pathname.endsWith("/git-upload-pack") ? "upload-pack" : "receive-pack";
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const lines: string[] = [];
    // receive-pack's commands end at the flush, and the raw pack follows; upload-pack's haves follow theirs.
    const commands = service === "receive-pack" ? packStart(body) : body.length;
    if (service === "receive-pack") received.push(body.length - commands);
    for (const line of readPkts(body.subarray(0, commands)))
      if (line !== null) lines.push(dec.decode(line).replace(/\n$/, "").split("\0")[0] ?? "");
    requests.push({
      service,
      repo: `${url.host}${url.pathname.replace(/\/git-(upload|receive)-pack$/, "")}`,
      auth: new Headers(init?.headers).get("Authorization"),
      lines,
    });
    if (service === "upload-pack") {
      const bands: Uint8Array[] = [];
      for (let at = 0; at < pack.length; at += 65_000)
        bands.push(pkt(concat([Uint8Array.of(1), pack.subarray(at, at + 65_000)])));
      return new Response(concat([pkt("NAK\n"), ...bands, FLUSH]));
    }
    const ref = lines[0]?.split(" ")[2] ?? "";
    const reply = replies.shift() ?? "ok";
    const report =
      reply === "busy"
        ? [pkt("ERR artifacts_git_receive_pack_busy\n")]
        : [pkt("unpack ok\n"), pkt(reply === "ok" ? `ok ${ref}\n` : `ng ${ref} stale ref\n`)];
    return new Response(concat([...report, FLUSH]));
  };
  return { fetch, requests, received };
}
