import { describe, expect, it } from "vitest";
import { diffTrees, type TreeChange } from "../src/diff.ts";
import { MODE_GITLINK, MODE_SYMLINK } from "../src/objects.ts";
import { historyArb, sides } from "./gen.ts";
import type { FileSpec, TreeModel } from "./git-harness.ts";
import { type Leaf, MemoryStore } from "./store.ts";
import { fc } from "./support/fast-check.ts";

/** Two trees that share most of their content, and now and then an empty side. */
const pairArb = fc.tuple(historyArb, fc.nat({ max: 19 })).map(([h, roll]) => {
  const { a, b } = sides(h);
  if (roll === 0) return { a, b: new Map() as TreeModel };
  if (roll === 1) return { a: new Map() as TreeModel, b };
  return { a, b };
});

async function stored(a: TreeModel, b: TreeModel) {
  const store = new MemoryStore();
  const oldTree = await store.write(a);
  const newTree = await store.write(b);
  return { store, oldTree, newTree };
}

/** What diff(b, a) must be, given diff(a, b). */
function mirror(rows: readonly TreeChange[]): TreeChange[] {
  return rows.map((r) => {
    const change = r.change === "added" ? "deleted" : r.change === "deleted" ? "added" : r.change;
    return {
      path: r.path,
      change,
      ...(r.newOid === undefined ? {} : { oldOid: r.newOid }),
      ...(r.oldOid === undefined ? {} : { newOid: r.oldOid }),
      ...(r.newMode === undefined ? {} : { oldMode: r.newMode }),
      ...(r.oldMode === undefined ? {} : { newMode: r.oldMode }),
    };
  });
}

/** Where a row breaks its kind's shape: which fields it carries, and whether its modes agree with the kind. */
function misshapen(row: TreeChange): boolean {
  const old = row.oldMode !== undefined && row.oldOid !== undefined;
  const now = row.newMode !== undefined && row.newOid !== undefined;
  const none = row.oldMode === undefined && row.oldOid === undefined;
  const gone = row.newMode === undefined && row.newOid === undefined;
  if (row.change === "added") return !(none && now);
  if (row.change === "deleted") return !(old && gone);
  const sameKind = kind(row.oldMode ?? "") === kind(row.newMode ?? "");
  return !(old && now && (row.change === "modified" ? sameKind : !sameKind));
}

const file = (data: string): FileSpec => ({ mode: "100644", data });

const kind = (mode: string) => (mode === MODE_SYMLINK ? "symlink" : mode === MODE_GITLINK ? "gitlink" : "file");
const bytewise = (x: string, y: string) => Buffer.compare(Buffer.from(x), Buffer.from(y));

describe("diffTrees", () => {
  it("[diff.identical-empty] identical trees give no rows and open no tree", async () => {
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ a }) => {
        const store = new MemoryStore();
        const tree = await store.write(a);
        const twin = await store.write(new Map(a));
        expect(twin).toBe(tree);
        expect(await diffTrees(store, tree, twin)).toEqual([]);
        expect(await diffTrees(store, null, null)).toEqual([]);
        expect(store.reads).toEqual([]);
      }),
    );
  });

  it("[diff.symmetric] diff(b, a) mirrors diff(a, b): added and deleted swap, old and new swap, same order", async () => {
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ a, b }) => {
        const { store, oldTree, newTree } = await stored(a, b);
        const forward = await diffTrees(store, oldTree, newTree);
        const backward = await diffTrees(store, newTree, oldTree);
        expect(backward).toEqual(mirror(forward));
      }),
    );
  });

  it("[diff.apply] applying the rows to the old tree's leaves gives the new tree's leaves, and no row is a no-op", async () => {
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ a, b }) => {
        const { store, oldTree, newTree } = await stored(a, b);
        const rows = await diffTrees(store, oldTree, newTree);
        const leaves = new Map<string, Leaf>(store.leaves(oldTree));
        const found: (Leaf | undefined)[] = [];
        const claimed: (Leaf | undefined)[] = [];
        for (const row of rows) {
          found.push(leaves.get(row.path));
          claimed.push(row.change === "added" ? undefined : { mode: row.oldMode ?? "", oid: row.oldOid ?? "" });
          if (row.change === "deleted") leaves.delete(row.path);
          else leaves.set(row.path, { mode: row.newMode ?? "", oid: row.newOid ?? "" });
        }
        expect(found).toEqual(claimed);
        expect(leaves).toEqual(store.leaves(newTree));
        expect(rows.filter((r) => r.oldMode === r.newMode && r.oldOid === r.newOid)).toEqual([]);
      }),
    );
  });

  it("[diff.reads-exact] it opens exactly the trees whose id differs from the other side's tree at the same path", async () => {
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ a, b }) => {
        const { store, oldTree, newTree } = await stored(a, b);
        const left = store.trees(oldTree);
        const right = store.trees(newTree);
        const needed = [
          ...[...left].filter(([path, oid]) => right.get(path) !== oid).map(([, oid]) => oid),
          ...[...right].filter(([path, oid]) => left.get(path) !== oid).map(([, oid]) => oid),
        ];
        await diffTrees(store, oldTree, newTree);
        expect(store.reads.toSorted()).toEqual(needed.toSorted());
      }),
    );
  });

  it("[diff.kind-and-order] rows are in strictly increasing bytewise path order, and each kind agrees with the modes", async () => {
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ a, b }) => {
        const { store, oldTree, newTree } = await stored(a, b);
        const rows = await diffTrees(store, oldTree, newTree);
        expect(rows.slice(1).filter((row, i) => bytewise(rows[i]?.path ?? "", row.path) >= 0)).toEqual([]);
        expect(rows.filter(misshapen)).toEqual([]);
      }),
    );
  });

  it("[diff.git-example] reports what git diff-tree -r reports for a mode change, type changes and dir/file swaps", async () => {
    const a: TreeModel = new Map<string, FileSpec>([
      ["a/x", file("x\n")],
      ["b", file("z\n")],
      ["g", file("g\n")],
      ["l", file("l\n")],
      ["m", file("m\n")],
    ]);
    const b: TreeModel = new Map<string, FileSpec>([
      ["a", file("nowfile\n")],
      ["b/inner", file("bb\n")],
      ["g", { mode: "160000", data: "1".repeat(40) }],
      ["l", { mode: "120000", data: "target" }],
      ["m", { mode: "100755", data: "m\n" }],
    ]);
    const { store, oldTree, newTree } = await stored(a, b);
    const rows = await diffTrees(store, oldTree, newTree);
    expect(rows.map((r) => [r.change, r.path, r.oldMode ?? "-", r.newMode ?? "-"])).toEqual([
      ["added", "a", "-", "100644"],
      ["deleted", "a/x", "100644", "-"],
      ["deleted", "b", "100644", "-"],
      ["added", "b/inner", "-", "100644"],
      ["type-changed", "g", "100644", "160000"],
      ["type-changed", "l", "100644", "120000"],
      ["modified", "m", "100644", "100755"],
    ]);
    expect(rows.find((r) => r.path === "m")?.oldOid).toBe(rows.find((r) => r.path === "m")?.newOid);
  });
});
