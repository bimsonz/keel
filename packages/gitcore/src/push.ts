// A protocol v1 receive-pack push over smart HTTP (gitprotocol-http,
// gitprotocol-pack, gitprotocol-common): pkt-line framing, the ref-update
// commands, the pack, and the report-status answer.
//
// Every update carries its old id explicitly. The server compares it with the
// ref and refuses a mismatch, so the caller's expectation is the
// compare-and-swap; nothing is read from an advertisement.

import { concat, dec, enc, ZERO_OID } from "./bytes.ts";

export function pkt(line: string | Uint8Array): Uint8Array {
  const body = typeof line === "string" ? enc.encode(line) : line;
  const len = (body.length + 4).toString(16).padStart(4, "0");
  return concat([enc.encode(len), body]);
}

export const FLUSH = enc.encode("0000");

/** Each pkt-line's payload, or null for a flush, delim or response-end packet. */
export function* readPkts(buf: Uint8Array): Generator<Uint8Array | null> {
  let p = 0;
  while (p + 4 <= buf.length) {
    const len = Number.parseInt(dec.decode(buf.subarray(p, p + 4)), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${p}`);
    if (len < 4) {
      p += 4;
      yield null;
      continue;
    }
    if (p + len > buf.length) throw new Error(`truncated pkt-line at ${p}`);
    yield buf.subarray(p + 4, p + len);
    p += len;
  }
}

/**
 * Where to push. `url` is the repo's git remote; it embeds the account id, so
 * it is never put in an error or a log. A public remote read with no
 * credential has no `token`, and its requests carry no Authorization.
 */
export interface GitRemote {
  readonly url: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
}

/** The credential each request to `remote` carries: none for a public remote. */
export const authorizationOf = (remote: GitRemote): Readonly<Record<string, string>> =>
  remote.token === undefined ? {} : { Authorization: `Bearer ${remote.token}` };

/** One ref update: `old` is what the ref must hold now (`ZERO_OID`: must not exist), `new` what it becomes (`ZERO_OID`: delete). */
export interface RefUpdate {
  readonly ref: string;
  readonly old: string;
  readonly new: string;
}

export type RefStatus = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * What the server did:
 * - `applied`: the pack unpacked and every ref moved;
 * - `rejected`: the server answered, but the pack failed or some ref did not
 *   move (a multi-ref push is all-or-nothing, so none moved);
 * - `busy`: `ERR artifacts_git_receive_pack_busy`, nothing applied, try again;
 * - `failed`: anything else (an HTTP error, another `ERR`, an unreadable answer).
 */
export type PushOutcome =
  | { readonly kind: "applied" }
  | {
      readonly kind: "rejected";
      readonly unpack: string | null;
      readonly refs: Readonly<Record<string, RefStatus>>;
    }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly status: number; readonly message: string };

export const BUSY = "artifacts_git_receive_pack_busy";

export interface Report {
  readonly unpack: string | null;
  readonly refs: ReadonlyMap<string, RefStatus>;
  readonly errors: readonly string[];
}

/** Parses a report-status answer, with or without side-band framing. */
export function parseReport(buf: Uint8Array): Report {
  let unpack: string | null = null;
  const refs = new Map<string, RefStatus>();
  const errors: string[] = [];
  const lines = (payload: Uint8Array): void => {
    if (payload[0] === 1) {
      // Side-band data: report-status pkt-lines nested inside.
      for (const inner of readPkts(payload.subarray(1))) if (inner !== null) lines(inner);
      return;
    }
    if (payload[0] === 2 || payload[0] === 3) return;
    const line = dec.decode(payload).replace(/\n$/, "");
    if (line.startsWith("ERR ")) errors.push(line.slice(4));
    else if (line.startsWith("unpack ")) unpack = line.slice(7);
    else if (line.startsWith("ok ")) refs.set(line.slice(3), { ok: true });
    else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      refs.set(sp < 0 ? rest : rest.slice(0, sp), {
        ok: false,
        reason: sp < 0 ? "" : rest.slice(sp + 1),
      });
    }
  };
  for (const payload of readPkts(buf)) if (payload !== null) lines(payload);
  return { unpack, refs, errors };
}

/** What a remote advertises: its refs by full name, and the branch its HEAD names, when it names one. */
export interface Advertisement {
  readonly refs: ReadonlyMap<string, string>;
  /** The full ref HEAD's `symref=HEAD:<ref>` capability names. */
  readonly head: string | undefined;
}

const SYMREF_HEAD = "symref=HEAD:";

/** What a remote advertises (`GET info/refs?service=git-upload-pack`). A read token is enough. */
export async function advertisement(remote: GitRemote): Promise<Advertisement> {
  const f = remote.fetch ?? fetch;
  const res = await f(`${remote.url}/info/refs?service=git-upload-pack`, {
    headers: authorizationOf(remote),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`ref advertisement answered HTTP ${res.status}`);
  const refs = new Map<string, string>();
  let head: string | undefined;
  for (const payload of readPkts(body)) {
    if (payload === null) continue;
    const line = dec.decode(payload).replace(/\n$/, "");
    if (line.startsWith("# service=")) continue;
    const nul = line.indexOf("\0");
    const [oid, name] = (nul < 0 ? line : line.slice(0, nul)).split(" ");
    if (oid !== undefined && name !== undefined && name !== "capabilities^{}") refs.set(name, oid);
    const symref =
      nul < 0
        ? undefined
        : line
            .slice(nul + 1)
            .split(" ")
            .find((capability) => capability.startsWith(SYMREF_HEAD));
    if (symref !== undefined) head = symref.slice(SYMREF_HEAD.length);
  }
  return { refs, head };
}

/** The refs a remote advertises, by full name. A read token is enough. */
export async function advertisedRefs(remote: GitRemote): Promise<ReadonlyMap<string, string>> {
  return (await advertisement(remote)).refs;
}

/** Applied only when the pack unpacked and every update's ref reports ok. */
export function outcomeOf(updates: readonly RefUpdate[], report: Report): PushOutcome {
  if (report.errors.includes(BUSY)) return { kind: "busy" };
  if (report.errors.length > 0)
    return {
      kind: "failed",
      status: 200,
      message: `server refused the push: ${report.errors.join("; ")}`,
    };
  const applied =
    report.unpack === "ok" && updates.every((u) => report.refs.get(u.ref)?.ok === true);
  return applied
    ? { kind: "applied" }
    : { kind: "rejected", unpack: report.unpack, refs: Object.fromEntries(report.refs) };
}

/**
 * Pushes `updates` with `pack` in one receive-pack request. More than one
 * update is sent `atomic`. A pack is needed unless every update deletes.
 */
export async function receivePack(
  remote: GitRemote,
  updates: readonly RefUpdate[],
  pack: Uint8Array | null,
): Promise<PushOutcome> {
  if (updates.length === 0) throw new Error("a push needs at least one ref update");
  const caps = [
    "report-status",
    ...(updates.length > 1 ? ["atomic"] : []),
    "agent=keel-gitcore",
  ].join(" ");
  const commands = updates.map((u, i) =>
    pkt(`${u.old} ${u.new} ${u.ref}${i === 0 ? `\0${caps}` : ""}\n`),
  );
  const deletesOnly = updates.every((u) => u.new === ZERO_OID);
  if (!deletesOnly && pack === null)
    throw new Error("a push that moves a ref to an object needs a pack");
  const body = concat([
    ...commands,
    FLUSH,
    deletesOnly ? new Uint8Array(0) : (pack ?? new Uint8Array(0)),
  ]);
  const f = remote.fetch ?? fetch;
  const res = await f(`${remote.url}/git-receive-pack`, {
    method: "POST",
    headers: {
      ...authorizationOf(remote),
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
    },
    body,
  });
  const answer = new Uint8Array(await res.arrayBuffer());
  if (!res.ok)
    return {
      kind: "failed",
      status: res.status,
      message: `receive-pack answered HTTP ${res.status}`,
    };
  try {
    return outcomeOf(updates, parseReport(answer));
  } catch (e) {
    return {
      kind: "failed",
      status: res.status,
      message: `unreadable receive-pack answer: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
