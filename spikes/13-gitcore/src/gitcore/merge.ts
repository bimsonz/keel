// Path-level three-way merge. It never merges file contents: for every path
// it either takes the one side that changed, takes a result both sides agree
// on byte-for-byte (same object id), or refuses. It also refuses whole classes
// of input where real git's merge machinery (rename detection, recursive
// virtual bases, mode handling) could produce a different tree.

import {
  type CommitInfo,
  decodeCommit,
  decodeTree,
  encodeTree,
  type GitObject,
  hashObject,
  MODE_EXEC,
  MODE_FILE,
  MODE_GITLINK,
  MODE_SYMLINK,
  MODE_TREE,
  type TreeEntry,
} from "./objects";

export interface ObjectReader {
  readTree(oid: string): Promise<TreeEntry[]>;
  readBlob(oid: string): Promise<Uint8Array>;
  readCommit(oid: string): Promise<CommitInfo>;
}

export type RefusalReason =
  | "no-merge-base"
  | "criss-cross"
  | "dir-file"
  | "mode-change"
  | "symlink"
  | "gitlink"
  | "binary"
  | "rename-exact"
  | "rename-similar"
  | "both-modified"
  | "add-add"
  | "modify-delete";

export class Refusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly path: string,
  ) {
    super(`refused: ${reason} at ${path || "/"}`);
  }
}

/** Test seams used only to prove the differential test can fail. */
export type SeededBug = "ours-wins" | "no-rename-guard";

export interface MergeOptions {
  /** Similarity at or above which a delete+add pair counts as a rename. */
  renameThreshold?: number;
  bug?: SeededBug;
}

export type MergeResult =
  | { ok: true; tree: string; base: string; newObjects: Map<string, GitObject> }
  | { ok: false; reason: RefusalReason; path: string };

/** Memoising wrapper so repeated reads of one object cost one round trip. */
export class CachingReader implements ObjectReader {
  private trees = new Map<string, Promise<TreeEntry[]>>();
  private blobs = new Map<string, Promise<Uint8Array>>();
  private commits = new Map<string, Promise<CommitInfo>>();
  constructor(private readonly inner: ObjectReader) {}
  readTree(oid: string) {
    let p = this.trees.get(oid);
    if (!p) this.trees.set(oid, (p = this.inner.readTree(oid)));
    return p;
  }
  readBlob(oid: string) {
    let p = this.blobs.get(oid);
    if (!p) this.blobs.set(oid, (p = this.inner.readBlob(oid)));
    return p;
  }
  readCommit(oid: string) {
    let p = this.commits.get(oid);
    if (!p) this.commits.set(oid, (p = this.inner.readCommit(oid)));
    return p;
  }
}

/** Serves objects written in this session before falling back to the store. */
export class OverlayReader implements ObjectReader {
  constructor(
    private readonly inner: ObjectReader,
    private readonly local: Map<string, GitObject>,
  ) {}
  readTree(oid: string) {
    const o = this.local.get(oid);
    return o?.type === "tree" ? Promise.resolve(decodeTree(o.body)) : this.inner.readTree(oid);
  }
  readBlob(oid: string) {
    const o = this.local.get(oid);
    return o?.type === "blob" ? Promise.resolve(o.body) : this.inner.readBlob(oid);
  }
  readCommit(oid: string) {
    const o = this.local.get(oid);
    return o?.type === "commit" ? Promise.resolve(decodeCommit(o.body)) : this.inner.readCommit(oid);
  }
}

// ---------------------------------------------------------------- merge base

async function ancestors(r: ObjectReader, start: string, memo: Map<string, Set<string>>): Promise<Set<string>> {
  const hit = memo.get(start);
  if (hit) return hit;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const c = queue.shift() as string;
    for (const p of (await r.readCommit(c)).parents) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  memo.set(start, seen);
  return seen;
}

/** All best common ancestors (git's "merge bases"), unsorted. */
export async function mergeBases(r: ObjectReader, a: string, b: string): Promise<string[]> {
  const memo = new Map<string, Set<string>>();
  const A = await ancestors(r, a, memo);
  const B = await ancestors(r, b, memo);
  const common = [...A].filter((c) => B.has(c));
  const best: string[] = [];
  for (const c of common) {
    let dominated = false;
    for (const d of common) {
      if (d !== c && (await ancestors(r, d, memo)).has(c)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) best.push(c);
  }
  return best;
}

// ---------------------------------------------------------------- tree diff

interface Change {
  path: string;
  before: TreeEntry | null;
  after: TreeEntry | null;
  typeChange: boolean;
}

const isTree = (e: TreeEntry | null | undefined): boolean => !!e && e.mode === MODE_TREE;
const same = (a: TreeEntry | null | undefined, b: TreeEntry | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.mode === b.mode && a.oid === b.oid);
const join = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

async function entries(r: ObjectReader, oid: string | null): Promise<Map<string, TreeEntry>> {
  const m = new Map<string, TreeEntry>();
  if (oid) for (const e of await r.readTree(oid)) m.set(e.name, e);
  return m;
}

async function listFiles(r: ObjectReader, tree: string, prefix: string, out: Array<[string, TreeEntry]>) {
  for (const e of await r.readTree(tree)) {
    if (isTree(e)) await listFiles(r, e.oid, join(prefix, e.name), out);
    else out.push([join(prefix, e.name), e]);
  }
}

/** File-level diff; subtrees whose ids match are skipped without being read. */
export async function diffTrees(r: ObjectReader, a: string | null, b: string | null, prefix = ""): Promise<Change[]> {
  const out: Change[] = [];
  if (a === b) return out;
  const ea = await entries(r, a);
  const eb = await entries(r, b);
  const names = new Set([...ea.keys(), ...eb.keys()]);
  for (const name of names) {
    const x = ea.get(name) ?? null;
    const y = eb.get(name) ?? null;
    if (same(x, y)) continue;
    const path = join(prefix, name);
    if (x && y && isTree(x) && isTree(y)) {
      out.push(...(await diffTrees(r, x.oid, y.oid, path)));
      continue;
    }
    const typeChange = !!x && !!y && isTree(x) !== isTree(y);
    if (x && isTree(x)) {
      const files: Array<[string, TreeEntry]> = [];
      await listFiles(r, x.oid, path, files);
      for (const [p, e] of files) out.push({ path: p, before: e, after: null, typeChange });
    }
    if (y && isTree(y)) {
      const files: Array<[string, TreeEntry]> = [];
      await listFiles(r, y.oid, path, files);
      for (const [p, e] of files) out.push({ path: p, before: null, after: e, typeChange });
    }
    if (!isTree(x) || !isTree(y)) {
      const before = isTree(x) ? null : x;
      const after = isTree(y) ? null : y;
      if (before || after) out.push({ path, before, after, typeChange });
    }
  }
  return out;
}

// ---------------------------------------------------------------- guards

/** git's own heuristic: a NUL in the first 8000 bytes means binary. */
export function isBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function chunks(b: Uint8Array): Map<string, number> {
  // Split like git's rename scorer: at each newline or every 64 bytes.
  const m = new Map<string, number>();
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a || i - start + 1 === 64) {
      const k = String.fromCharCode(...b.subarray(start, i + 1));
      m.set(k, (m.get(k) ?? 0) + (i + 1 - start));
      start = i + 1;
    }
  }
  if (start < b.length) {
    const k = String.fromCharCode(...b.subarray(start));
    m.set(k, (m.get(k) ?? 0) + (b.length - start));
  }
  return m;
}

/** Bytes shared between two blobs (chunk multiset intersection) over the larger size. */
export function similarity(a: Uint8Array, b: Uint8Array): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const ca = chunks(a);
  const cb = chunks(b);
  let shared = 0;
  for (const [k, n] of ca) {
    const m = cb.get(k);
    if (m) shared += Math.min(n, m);
  }
  return shared / max;
}

async function guardChanges(r: ObjectReader, changes: Change[]) {
  for (const c of changes) {
    if (c.typeChange) throw new Refusal("dir-file", c.path);
    for (const e of [c.before, c.after]) {
      if (e?.mode === MODE_SYMLINK) throw new Refusal("symlink", c.path);
      if (e?.mode === MODE_GITLINK) throw new Refusal("gitlink", c.path);
      if (e && e.mode !== MODE_FILE && e.mode !== MODE_EXEC) throw new Refusal("mode-change", c.path);
    }
    if (c.before && c.after && c.before.mode !== c.after.mode) throw new Refusal("mode-change", c.path);
  }
  for (const c of changes) {
    for (const e of [c.before, c.after]) {
      if (e && isBinary(await r.readBlob(e.oid))) throw new Refusal("binary", c.path);
    }
  }
}

async function guardRenames(r: ObjectReader, changes: Change[], threshold: number) {
  const deleted = changes.filter((c) => c.before && !c.after);
  const added = changes.filter((c) => !c.before && c.after);
  if (deleted.length === 0 || added.length === 0) return;
  for (const d of deleted) {
    for (const a of added) {
      if (d.before?.oid === a.after?.oid) throw new Refusal("rename-exact", `${d.path} -> ${a.path}`);
    }
  }
  for (const d of deleted) {
    const src = await r.readBlob(d.before?.oid as string);
    for (const a of added) {
      const dst = await r.readBlob(a.after?.oid as string);
      if (similarity(src, dst) >= threshold) throw new Refusal("rename-similar", `${d.path} -> ${a.path}`);
    }
  }
}

// ---------------------------------------------------------------- merge

async function mergeTree(
  r: ObjectReader,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  prefix: string,
  out: Map<string, GitObject>,
  opts: MergeOptions,
): Promise<string | null> {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const eb = await entries(r, base);
  const eo = await entries(r, ours);
  const et = await entries(r, theirs);
  const names = new Set([...eb.keys(), ...eo.keys(), ...et.keys()]);
  const result: TreeEntry[] = [];
  for (const name of names) {
    const b = eb.get(name) ?? null;
    const o = eo.get(name) ?? null;
    const t = et.get(name) ?? null;
    const path = join(prefix, name);
    let pick: TreeEntry | null;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else {
      const present = [b, o, t].filter((e): e is TreeEntry => !!e);
      if (present.every(isTree)) {
        const oid = await mergeTree(r, b?.oid ?? null, o?.oid ?? null, t?.oid ?? null, path, out, opts);
        pick = oid ? { name, mode: MODE_TREE, oid } : null;
      } else if (present.some(isTree)) {
        throw new Refusal("dir-file", path);
      } else if (opts.bug === "ours-wins" && o && t) {
        pick = o;
      } else if (!b) {
        throw new Refusal("add-add", path);
      } else if (!o || !t) {
        throw new Refusal("modify-delete", path);
      } else {
        throw new Refusal("both-modified", path);
      }
    }
    if (pick) result.push(pick);
  }
  if (result.length === 0) return null;
  const body = encodeTree(result);
  const oid = await hashObject("tree", body);
  out.set(oid, { type: "tree", body });
  return oid;
}

/** Merge two trees against an explicit base tree. */
export async function mergeTrees(
  reader: ObjectReader,
  base: string,
  ours: string,
  theirs: string,
  opts: MergeOptions = {},
): Promise<{ tree: string; newObjects: Map<string, GitObject> }> {
  const r = reader instanceof CachingReader ? reader : new CachingReader(reader);
  const changes = [...(await diffTrees(r, base, ours)), ...(await diffTrees(r, base, theirs))];
  await guardChanges(r, changes);
  const out = new Map<string, GitObject>();
  const tree = await mergeTree(r, base, ours, theirs, "", out, opts);
  if (opts.bug !== "no-rename-guard") await guardRenames(r, changes, opts.renameThreshold ?? 0.3);
  if (!tree) {
    const body = new Uint8Array(0);
    const oid = await hashObject("tree", body);
    out.set(oid, { type: "tree", body });
    return { tree: oid, newObjects: out };
  }
  return { tree, newObjects: out };
}

/** Merge two commits the way `git merge-tree --write-tree ours theirs` would, or refuse. */
export async function mergeCommits(
  reader: ObjectReader,
  ours: string,
  theirs: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const r = new CachingReader(reader);
  try {
    const bases = await mergeBases(r, ours, theirs);
    if (bases.length === 0) throw new Refusal("no-merge-base", "");
    if (bases.length > 1) throw new Refusal("criss-cross", "");
    const base = bases[0] as string;
    const [b, o, t] = await Promise.all([r.readCommit(base), r.readCommit(ours), r.readCommit(theirs)]);
    const { tree, newObjects } = await mergeTrees(r, b.tree, o.tree, t.tree, opts);
    return { ok: true, tree, base, newObjects };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.reason, path: e.path };
    throw e;
  }
}
