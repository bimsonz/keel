// Three-way merge of trees (ported from spike S13, which ran 10,000
// differential histories against `git merge-tree` with no wrong tree). For
// every path it takes the one side that changed, takes a result both sides
// agree on byte for byte (same object id), merges a text file both changed by
// hunk as git does (`merge-text.ts`), or refuses. It also refuses whole
// classes of input where git's merge machinery (rename detection, recursive
// virtual bases, mode handling, merge attributes) could produce a different
// tree. Refusing is always safe: MergeBox takes over.

import { dec } from "./bytes.ts";
import { mergeText, type TextRefusal } from "./merge-text.ts";
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
} from "./objects.ts";

/** The reads a merge needs. Each throws `MissingObject` for an id the store lacks. */
export interface ObjectReader {
  readTree(oid: string): Promise<readonly TreeEntry[]>;
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
  | TextRefusal
  | "attributes"
  | "add-add"
  | "modify-delete";

/** GitCore will not merge this; `path` is where it stopped ("" for the whole merge). */
export class Refusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly path: string,
  ) {
    super(`refused: ${reason} at ${path === "" ? "/" : path}`);
  }
}

export interface MergeOptions {
  /** Similarity at or above which a delete and an add count as a rename (git's default is 50%; refusing at 30% is safer). */
  readonly renameThreshold?: number;
}

/** A merged tree and the trees and merged blobs written to build it, which the target repo may lack. */
export interface MergedTree {
  readonly tree: string;
  readonly newObjects: ReadonlyMap<string, GitObject>;
}

export type MergeResult =
  | ({ readonly ok: true; readonly base: string } & MergedTree)
  | { readonly ok: false; readonly reason: RefusalReason; readonly path: string };

/** Memoises reads, so repeated reads of one object cost one round trip. */
export class CachingReader implements ObjectReader {
  private readonly trees = new Map<string, Promise<readonly TreeEntry[]>>();
  private readonly blobs = new Map<string, Promise<Uint8Array>>();
  private readonly commits = new Map<string, Promise<CommitInfo>>();

  constructor(private readonly inner: ObjectReader) {}

  readTree(oid: string) {
    return memo(this.trees, oid, () => this.inner.readTree(oid));
  }

  readBlob(oid: string) {
    return memo(this.blobs, oid, () => this.inner.readBlob(oid));
  }

  readCommit(oid: string) {
    return memo(this.commits, oid, () => this.inner.readCommit(oid));
  }
}

function memo<A>(cache: Map<string, Promise<A>>, key: string, read: () => Promise<A>): Promise<A> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const fresh = read();
  cache.set(key, fresh);
  return fresh;
}

/** Serves objects written in this session before falling back to the store. */
export class OverlayReader implements ObjectReader {
  constructor(
    private readonly inner: ObjectReader,
    private readonly local: ReadonlyMap<string, GitObject>,
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
    return o?.type === "commit"
      ? Promise.resolve(decodeCommit(o.body))
      : this.inner.readCommit(oid);
  }
}

// ---------------------------------------------------------------- merge base

async function ancestors(
  r: ObjectReader,
  start: string,
  known: Map<string, ReadonlySet<string>>,
): Promise<ReadonlySet<string>> {
  const hit = known.get(start);
  if (hit !== undefined) return hit;
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const parent of (await r.readCommit(next)).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  known.set(start, seen);
  return seen;
}

/** All best common ancestors (git's merge bases), unsorted. */
export async function mergeBases(r: ObjectReader, a: string, b: string): Promise<string[]> {
  const known = new Map<string, ReadonlySet<string>>();
  const ofA = await ancestors(r, a, known);
  const ofB = await ancestors(r, b, known);
  const common = [...ofA].filter((c) => ofB.has(c));
  const best: string[] = [];
  for (const c of common) {
    let dominated = false;
    for (const d of common) {
      if (d !== c && (await ancestors(r, d, known)).has(c)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) best.push(c);
  }
  return best;
}

// ---------------------------------------------------------------- file-level diff

/** One changed file between two trees, with a directory expanded into its files. */
interface FileChange {
  readonly path: string;
  readonly before: TreeEntry | null;
  readonly after: TreeEntry | null;
  /** A directory became a file here, or a file a directory. */
  readonly typeChange: boolean;
}

type SubtreeEntry = TreeEntry & { readonly mode: typeof MODE_TREE };
const isTree = (e: TreeEntry | null | undefined): e is SubtreeEntry => e?.mode === MODE_TREE;
const same = (a: TreeEntry | null, b: TreeEntry | null) =>
  a === null ? b === null : b !== null && a.mode === b.mode && a.oid === b.oid;
const join = (prefix: string, name: string) => (prefix === "" ? name : `${prefix}/${name}`);

async function entries(r: ObjectReader, oid: string | null): Promise<Map<string, TreeEntry>> {
  const byName = new Map<string, TreeEntry>();
  if (oid !== null) for (const e of await r.readTree(oid)) byName.set(e.name, e);
  return byName;
}

async function listFiles(
  r: ObjectReader,
  tree: string,
  prefix: string,
): Promise<[string, TreeEntry][]> {
  // Subtrees are read side by side; the files come back in the tree's order.
  const each = await Promise.all(
    (await r.readTree(tree)).map(async (e): Promise<[string, TreeEntry][]> =>
      isTree(e) ? listFiles(r, e.oid, join(prefix, e.name)) : [[join(prefix, e.name), e]],
    ),
  );
  return each.flat();
}

/**
 * Files that differ; subtrees whose ids match are skipped unread. Both trees,
 * and every subtree that differs, are read side by side: a diff costs about
 * one round trip a level, not one a subtree. The files come back in the
 * trees' order.
 */
async function changedFiles(
  r: ObjectReader,
  a: string | null,
  b: string | null,
  prefix = "",
): Promise<FileChange[]> {
  if (a === b) return [];
  const [ea, eb] = await Promise.all([entries(r, a), entries(r, b)]);
  const each = await Promise.all(
    [...new Set([...ea.keys(), ...eb.keys()])].map(async (name): Promise<FileChange[]> => {
      const x = ea.get(name) ?? null;
      const y = eb.get(name) ?? null;
      if (same(x, y)) return [];
      const path = join(prefix, name);
      if (isTree(x) && isTree(y)) return changedFiles(r, x.oid, y.oid, path);
      const typeChange = x !== null && y !== null && isTree(x) !== isTree(y);
      const [gone, come] = await Promise.all([
        isTree(x) ? listFiles(r, x.oid, path) : Promise.resolve([]),
        isTree(y) ? listFiles(r, y.oid, path) : Promise.resolve([]),
      ]);
      const out: FileChange[] = [
        ...gone.map(([p, e]) => ({ path: p, before: e, after: null, typeChange })),
        ...come.map(([p, e]) => ({ path: p, before: null, after: e, typeChange })),
      ];
      if (!isTree(x) || !isTree(y)) {
        const before = isTree(x) ? null : x;
        const after = isTree(y) ? null : y;
        if (before !== null || after !== null) out.push({ path, before, after, typeChange });
      }
      return out;
    }),
  );
  return each.flat();
}

// ---------------------------------------------------------------- guards

/** git's own heuristic: a NUL in the first 8000 bytes means binary. */
export function isBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/** Splits like git's rename scorer: at each newline, or every 64 bytes. */
function chunks(b: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (from: number, to: number) => {
    const key = String.fromCharCode(...b.subarray(from, to));
    counts.set(key, (counts.get(key) ?? 0) + (to - from));
  };
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a || i - start + 1 === 64) {
      add(start, i + 1);
      start = i + 1;
    }
  }
  if (start < b.length) add(start, b.length);
  return counts;
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
    if (m !== undefined) shared += Math.min(n, m);
  }
  return shared / max;
}

async function guardChanges(r: ObjectReader, changes: readonly FileChange[]): Promise<void> {
  for (const c of changes) {
    if (c.typeChange) throw new Refusal("dir-file", c.path);
    for (const e of [c.before, c.after]) {
      if (e?.mode === MODE_SYMLINK) throw new Refusal("symlink", c.path);
      if (e?.mode === MODE_GITLINK) throw new Refusal("gitlink", c.path);
      if (e !== null && e.mode !== MODE_FILE && e.mode !== MODE_EXEC)
        throw new Refusal("mode-change", c.path);
    }
    if (c.before !== null && c.after !== null && c.before.mode !== c.after.mode)
      throw new Refusal("mode-change", c.path);
  }
  // Read side by side, then judged in the changes' order, so the refusal names the same path.
  const blobs = await Promise.all(
    changes.map((c) =>
      Promise.all(
        [c.before, c.after].map((e) => (e === null ? Promise.resolve(null) : r.readBlob(e.oid))),
      ),
    ),
  );
  for (const [i, c] of changes.entries()) {
    for (const blob of blobs[i] ?? []) {
      if (blob !== null && isBinary(blob)) throw new Refusal("binary", c.path);
    }
  }
}

/** The parent directory of `path`, "" at the root. */
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Whether `tree` holds anything at `dir` ("" is the root itself). */
async function holds(r: ObjectReader, tree: string, dir: string): Promise<boolean> {
  let at: string | null = tree;
  for (const name of dir === "" ? [] : dir.split("/")) {
    if (at === null) return false;
    const entry: TreeEntry | undefined = (await r.readTree(at)).find((e) => e.name === name);
    at = isTree(entry) ? entry.oid : null;
  }
  return at !== null && (await r.readTree(at)).length > 0;
}

/**
 * Refuses a rename git would follow differently from a plain delete and add.
 * git detects renames on each side apart (a path one side deletes and the
 * same side adds again, exactly or `threshold` similar), and a rename changes
 * its result only where the other side changed the old path or the new one,
 * or where the side moved a whole directory away (nothing is left at the old
 * one) and the other side changed something under it. Anywhere else the
 * rename is the delete and the add, which is what the merge already wrote.
 */
async function guardRenames(
  r: ObjectReader,
  sides: readonly {
    readonly tree: string;
    readonly changes: readonly FileChange[];
    readonly other: readonly FileChange[];
  }[],
  threshold: number,
): Promise<void> {
  for (const { tree, changes, other } of sides) {
    // A gitlink names a commit of another repository, which nobody holds here: git never pairs one as a rename.
    const deleted = changes.flatMap((c) =>
      c.before !== null && c.after === null && c.before.mode !== MODE_GITLINK
        ? [{ path: c.path, entry: c.before }]
        : [],
    );
    const added = changes.flatMap((c) =>
      c.before === null && c.after !== null && c.after.mode !== MODE_GITLINK
        ? [{ path: c.path, entry: c.after }]
        : [],
    );
    if (deleted.length === 0 || added.length === 0) continue;
    /** Whether git would follow `from` to `to` into another result than the delete and the add. */
    const matters = async (from: string, to: string): Promise<boolean> => {
      if (other.some((c) => c.path === from || c.path === to)) return true;
      const dir = dirOf(from);
      if (dir === dirOf(to) || !other.some((c) => c.path.startsWith(`${dir}/`))) return false;
      return !(await holds(r, tree, dir));
    };
    for (const d of deleted) {
      for (const a of added) {
        if (d.entry.oid === a.entry.oid && (await matters(d.path, a.path)))
          throw new Refusal("rename-exact", `${d.path} -> ${a.path}`);
      }
    }
    for (const d of deleted) {
      const source = await r.readBlob(d.entry.oid);
      for (const a of added) {
        if (
          (await matters(d.path, a.path)) &&
          similarity(source, await r.readBlob(a.entry.oid)) >= threshold
        )
          throw new Refusal("rename-similar", `${d.path} -> ${a.path}`);
      }
    }
  }
}

// ---------------------------------------------------------------- merge

/** A `.gitattributes` naming either word may pick another merge driver (`merge=union`, `-merge`, `binary`). */
const MERGE_ATTRIBUTES = /merge|binary/;

/**
 * Both sides changed one text file (same mode as its base, not binary: the
 * guards ran first): merged by hunk, the blob written to `out`, or refused.
 * `attributes` are the `.gitattributes` blobs on its directory chain in any
 * of the three trees.
 */
async function mergeFile(
  r: ObjectReader,
  [base, ours, theirs]: readonly [TreeEntry, TreeEntry, TreeEntry],
  path: string,
  attributes: readonly string[],
  out: Map<string, GitObject>,
): Promise<TreeEntry> {
  for (const oid of attributes)
    if (MERGE_ATTRIBUTES.test(dec.decode(await r.readBlob(oid))))
      throw new Refusal("attributes", path);
  const [b, o, t] = await Promise.all([base, ours, theirs].map((e) => r.readBlob(e.oid)));
  const merged = mergeText(b ?? new Uint8Array(0), o ?? new Uint8Array(0), t ?? new Uint8Array(0));
  if (!merged.ok) throw new Refusal(merged.reason, path);
  const oid = await hashObject("blob", merged.merged);
  out.set(oid, { type: "blob", body: merged.merged });
  return { name: ours.name, mode: ours.mode, oid };
}

async function mergeTree(
  r: ObjectReader,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  prefix: string,
  out: Map<string, GitObject>,
  attributes: readonly string[] = [],
): Promise<string | null> {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const eb = await entries(r, base);
  const eo = await entries(r, ours);
  const et = await entries(r, theirs);
  const here = [
    ...attributes,
    ...[eb, eo, et].flatMap((level) => {
      const found = level.get(".gitattributes");
      return found === undefined || isTree(found) ? [] : [found.oid];
    }),
  ];
  const result: TreeEntry[] = [];
  for (const name of new Set([...eb.keys(), ...eo.keys(), ...et.keys()])) {
    const b = eb.get(name) ?? null;
    const o = eo.get(name) ?? null;
    const t = et.get(name) ?? null;
    const path = join(prefix, name);
    let pick: TreeEntry | null;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else {
      const present = [b, o, t].filter((e): e is TreeEntry => e !== null);
      if (present.every(isTree)) {
        const oid = await mergeTree(
          r,
          b?.oid ?? null,
          o?.oid ?? null,
          t?.oid ?? null,
          path,
          out,
          here,
        );
        pick = oid === null ? null : { name, mode: MODE_TREE, oid };
      } else if (present.some(isTree)) {
        throw new Refusal("dir-file", path);
      } else if (b === null) {
        throw new Refusal("add-add", path);
      } else if (o === null || t === null) {
        throw new Refusal("modify-delete", path);
      } else {
        pick = await mergeFile(r, [b, o, t], path, here, out);
      }
    }
    if (pick !== null) result.push(pick);
  }
  if (result.length === 0) return null;
  const body = encodeTree(result);
  const oid = await hashObject("tree", body);
  out.set(oid, { type: "tree", body });
  return oid;
}

/** Merges two trees against an explicit base tree, or throws `Refusal`. */
export async function mergeTrees(
  reader: ObjectReader,
  base: string,
  ours: string,
  theirs: string,
  options: MergeOptions = {},
): Promise<MergedTree> {
  const r = reader instanceof CachingReader ? reader : new CachingReader(reader);
  const [byOurs, byTheirs] = [
    await changedFiles(r, base, ours),
    await changedFiles(r, base, theirs),
  ];
  // A path one side alone changed merges as git's does, taking that side: only one both changed is guarded.
  const byBoth = new Set(
    byOurs.map((c) => c.path).filter((p) => byTheirs.some((c) => c.path === p)),
  );
  await guardChanges(
    r,
    [...byOurs, ...byTheirs].filter((c) => byBoth.has(c.path)),
  );
  const out = new Map<string, GitObject>();
  const tree = await mergeTree(r, base, ours, theirs, "", out);
  await guardRenames(
    r,
    [
      { tree: ours, changes: byOurs, other: byTheirs },
      { tree: theirs, changes: byTheirs, other: byOurs },
    ],
    options.renameThreshold ?? 0.3,
  );
  if (tree !== null) return { tree, newObjects: out };
  const empty = new Uint8Array(0);
  const oid = await hashObject("tree", empty);
  out.set(oid, { type: "tree", body: empty });
  return { tree: oid, newObjects: out };
}

/** Merges two commits as `git merge-tree --write-tree ours theirs` would, or refuses. */
export async function mergeCommits(
  reader: ObjectReader,
  ours: string,
  theirs: string,
  options: MergeOptions = {},
): Promise<MergeResult> {
  const r = new CachingReader(reader);
  try {
    const bases = await mergeBases(r, ours, theirs);
    const [base] = bases;
    if (base === undefined) throw new Refusal("no-merge-base", "");
    if (bases.length > 1) throw new Refusal("criss-cross", "");
    const [b, o, t] = await Promise.all([
      r.readCommit(base),
      r.readCommit(ours),
      r.readCommit(theirs),
    ]);
    return { ok: true, base, ...(await mergeTrees(r, b.tree, o.tree, t.tree, options)) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.reason, path: e.path };
    throw e;
  }
}
