// A repo shown to a git client as its `main` alone (gitprotocol-http,
// gitprotocol-pack, gitprotocol-v2). Whatever other refs the host holds and
// wherever its own HEAD points, a client's fetch is told of two refs: HEAD, a
// symbolic ref to refs/heads/main, and refs/heads/main itself. Only what
// lists refs is rewritten: the protocol 0 and 1 advertisement and protocol 2's
// `ls-refs`. A negotiation and its pack pass through untouched.

import { concat, dec, ZERO_OID } from "./bytes.ts";
import { FLUSH, pkt } from "./push.ts";

const MAIN = "refs/heads/main";
const SYMREF = `symref=HEAD:${MAIN}`;
/** Protocol 2's delimiter packet, between a command's capabilities and its arguments. */
const DELIM = Uint8Array.of(0x30, 0x30, 0x30, 0x31);
/** A ref line of either listing: an object id, a space, and the rest. */
const REF_LINE = /^[0-9a-f]{40} /;

/** One upload-pack request as a git client sends it over smart HTTP. */
export interface ServedRequest {
  readonly service: "advertise" | "negotiate";
  /** The client's `Git-Protocol` header (`version=2`), or null for protocol 0. */
  readonly protocol: string | null;
  readonly body: Uint8Array | null;
}

/**
 * How one request is served with main alone: `request` is what the host is
 * asked, and `rewrite` turns the host's whole answer into what the client
 * gets (null from it: the host's answer was not git's, and nothing of it is
 * passed on). A null `rewrite` is an answer streamed on as it comes.
 */
export interface MainOnly<R extends ServedRequest> {
  readonly request: R;
  readonly rewrite: ((answer: Uint8Array) => Uint8Array | null) | null;
}

/**
 * The one `ls-refs` a host is asked in place of a client's: main, and nothing
 * the answer is not written from.
 */
export const LS_REFS_MAIN = concat([
  pkt("command=ls-refs\n"),
  pkt("agent=keel\n"),
  DELIM,
  pkt(`ref-prefix ${MAIN}\n`),
  FLUSH,
]);

interface Packet {
  /** The packet as it stood in the buffer, length and all. */
  readonly raw: Uint8Array;
  /** Its payload as text, or null for a flush, delim or response-end packet. */
  readonly text: string | null;
}

/** A buffer's pkt-lines, or null when it is not pkt-lines to its end. */
function packetsOf(buf: Uint8Array): Packet[] | null {
  const out: Packet[] = [];
  let p = 0;
  while (p < buf.length) {
    const head = dec.decode(buf.subarray(p, p + 4));
    if (!/^[0-9a-f]{4}$/.test(head)) return null;
    const len = Number.parseInt(head, 16);
    if (len < 4) {
      out.push({ raw: buf.subarray(p, p + 4), text: null });
      p += 4;
      continue;
    }
    if (p + len > buf.length) return null;
    out.push({ raw: buf.subarray(p, p + len), text: dec.decode(buf.subarray(p + 4, p + len)) });
    p += len;
  }
  return out;
}

const isError = (packets: readonly Packet[]) =>
  packets.some((packet) => packet.text?.startsWith("ERR ") === true);

/** A ref line's name: past the object id, up to the capabilities, an attribute or the line's end. */
const refOf = (line: string) => line.slice(41).split(/[\0 \n]/)[0] ?? "";

/**
 * A host's ref advertisement with main alone. Protocol 2 advertises
 * capabilities and no ref, so it stands as it is. In protocol 0 and 1 every
 * ref line gives way to two, HEAD and main at main's commit, under the host's
 * own capabilities with HEAD's symbolic target said to be main; a repo with
 * no main is advertised as an empty one. Every other line stands.
 */
function advertisement(answer: Uint8Array): Uint8Array | null {
  const packets = packetsOf(answer);
  if (packets === null || isError(packets)) return null;
  const said = packets.flatMap((packet) =>
    packet.text === null || packet.text.startsWith("# service=") ? [] : [packet.text],
  );
  if (said[0] === "version 2\n") return answer;
  const refs = said.filter((line) => REF_LINE.test(line));
  const first = refs[0];
  if (first === undefined) return answer;
  const capabilities = (first.split("\0")[1] ?? "")
    .replace(/\n$/, "")
    .split(" ")
    .filter((capability) => capability !== "");
  const main = refs.find((line) => refOf(line) === MAIN)?.slice(0, 40);
  const symref = capabilities.findIndex((capability) => capability.startsWith("symref="));
  const others = capabilities.filter((capability) => !capability.startsWith("symref="));
  const shown =
    main === undefined
      ? [pkt(`${ZERO_OID} capabilities^{}\0${others.join(" ")}\n`)]
      : [
          pkt(
            `${main} HEAD\0${others.toSpliced(symref < 0 ? others.length : symref, 0, SYMREF).join(" ")}\n`,
          ),
          pkt(`${main} ${MAIN}\n`),
        ];
  let placed = false;
  return concat(
    packets.flatMap((packet) => {
      if (packet.text === null || !REF_LINE.test(packet.text)) return [packet.raw];
      if (placed) return [];
      placed = true;
      return shown;
    }),
  );
}

/** What a client's `ls-refs` asked for. */
interface LsRefs {
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: readonly string[];
}

/** A protocol 2 request's `ls-refs` arguments, or null when it is another command or no command at all. */
function lsRefsOf(body: Uint8Array): LsRefs | null {
  const packets = packetsOf(body);
  if (packets === null || packets[0]?.text?.replace(/\n$/, "") !== "command=ls-refs") return null;
  const delim = packets.findIndex((packet) => packet.text === null);
  const args = (delim < 0 ? [] : packets.slice(delim + 1)).flatMap((packet) =>
    packet.text === null ? [] : [packet.text.replace(/\n$/, "")],
  );
  return {
    symrefs: args.includes("symrefs"),
    unborn: args.includes("unborn"),
    prefixes: args
      .filter((arg) => arg.startsWith("ref-prefix "))
      .map((arg) => arg.slice("ref-prefix ".length)),
  };
}

/**
 * The answer to a client's `ls-refs`, written from the host's answer to
 * `LS_REFS_MAIN` as git writes one for a repo holding main alone: HEAD, with
 * its symbolic target when `symrefs` was asked, then main, each only where it
 * matches the client's prefixes (none asked: both). A repo with no main lists
 * an unborn HEAD when `unborn` and `symrefs` were both asked, and else nothing.
 */
function listed(asked: LsRefs, answer: Uint8Array): Uint8Array | null {
  const packets = packetsOf(answer);
  if (packets === null || isError(packets)) return null;
  const main = packets
    .flatMap((packet) => (packet.text === null ? [] : [packet.text]))
    .find((line) => REF_LINE.test(line) && refOf(line) === MAIN)
    ?.slice(0, 40);
  const matches = (ref: string) =>
    asked.prefixes.length === 0 || asked.prefixes.some((prefix) => ref.startsWith(prefix));
  const target = asked.symrefs ? ` symref-target:${MAIN}` : "";
  const lines: Uint8Array[] = [];
  if (main === undefined) {
    if (asked.unborn && asked.symrefs && matches("HEAD")) lines.push(pkt(`unborn HEAD${target}\n`));
  } else {
    if (matches("HEAD")) lines.push(pkt(`${main} HEAD${target}\n`));
    if (matches(MAIN)) lines.push(pkt(`${main} ${MAIN}\n`));
  }
  return concat([...lines, FLUSH]);
}

/**
 * How one upload-pack request is served so the client sees main alone. The
 * advertisement goes to the host as it came and its answer is rewritten. A
 * protocol 2 `ls-refs` is not passed on: the host is asked `LS_REFS_MAIN`,
 * and the client's own arguments shape the answer written from it (a filter
 * of the host's own answer would have no commit for HEAD when the client's
 * prefixes leave main out). Anything else, a negotiation in any protocol, is
 * the host's to answer and is not held.
 */
export function mainOnly<R extends ServedRequest>(request: R): MainOnly<R> {
  if (request.service === "advertise") return { request, rewrite: advertisement };
  if (request.protocol === "version=2" && request.body !== null) {
    const asked = lsRefsOf(request.body);
    if (asked !== null)
      return {
        request: { ...request, body: LS_REFS_MAIN },
        rewrite: (answer) => listed(asked, answer),
      };
  }
  return { request, rewrite: null };
}
