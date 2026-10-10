// Git object format: "<type> <len>\0<body>", object id = SHA-1 of that.
// Tree body: repeated "<mode> <name>\0<20 raw bytes>", entries sorted by name,
// where a tree entry sorts as if its name ended in "/".

import { concat, dec, enc, fromHex, sha1, toHex } from "./bytes";

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export const MODE_TREE = "40000";
export const MODE_FILE = "100644";
export const MODE_EXEC = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_GITLINK = "160000";

export interface TreeEntry {
  name: string;
  mode: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
}

export interface GitObject {
  type: ObjectType;
  body: Uint8Array;
}

export function normaliseMode(mode: string | number): string {
  const s = typeof mode === "number" ? mode.toString(8) : mode;
  const t = s.replace(/^0+/, "");
  return t === "" ? "0" : t;
}

export function frame(type: ObjectType, body: Uint8Array): Uint8Array {
  return concat([enc.encode(`${type} ${body.length}\0`), body]);
}

export function hashObject(type: ObjectType, body: Uint8Array): Promise<string> {
  return sha1(frame(type, body));
}

function sortKey(e: TreeEntry): Uint8Array {
  return enc.encode(e.mode === MODE_TREE ? `${e.name}/` : e.name);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((x, y) => compareBytes(sortKey(x), sortKey(y)));
}

export function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const e of sortTreeEntries(entries)) {
    if (seen.has(e.name)) throw new Error(`duplicate tree entry ${e.name}`);
    seen.add(e.name);
    if (e.name === "" || e.name.includes("/") || e.name.includes("\0")) {
      throw new Error(`bad tree entry name ${JSON.stringify(e.name)}`);
    }
    parts.push(enc.encode(`${normaliseMode(e.mode)} ${e.name}\0`), fromHex(e.oid));
  }
  return concat(parts);
}

export function decodeTree(body: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const nul = body.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > body.length) throw new Error("corrupt tree");
    const mode = dec.decode(body.subarray(i, sp));
    const name = dec.decode(body.subarray(sp + 1, nul));
    const oid = toHex(body.subarray(nul + 1, nul + 21));
    out.push({ name, mode: normaliseMode(mode), oid });
    i = nul + 21;
  }
  return out;
}

export function decodeCommit(body: Uint8Array): CommitInfo {
  const text = dec.decode(body);
  const headerEnd = text.indexOf("\n\n");
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  let tree = "";
  const parents: string[] = [];
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
  }
  if (!tree) throw new Error("commit without tree");
  return { tree, parents };
}

export interface Signature {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
  /** e.g. "+0000" */
  tz?: string;
}

export interface CommitSpec {
  tree: string;
  parents: readonly string[];
  author: Signature;
  committer: Signature;
  message: string;
  trailers?: ReadonlyArray<readonly [string, string]>;
}

function sig(s: Signature): string {
  if (/[<>\n]/.test(s.name) || /[<>\n]/.test(s.email)) throw new Error("bad identity");
  return `${s.name} <${s.email}> ${Math.floor(s.time)} ${s.tz ?? "+0000"}`;
}

/** Serialise a commit body. Trailers are appended as a final paragraph. */
export function encodeCommit(c: CommitSpec): Uint8Array {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${sig(c.author)}`, `committer ${sig(c.committer)}`);
  let msg = c.message.replace(/\n+$/, "");
  if (c.trailers && c.trailers.length > 0) {
    for (const [k, v] of c.trailers) {
      if (!/^[A-Za-z0-9-]+$/.test(k) || v.includes("\n")) throw new Error(`bad trailer ${k}`);
    }
    msg += `\n\n${c.trailers.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  }
  return enc.encode(`${lines.join("\n")}\n\n${msg}\n`);
}
