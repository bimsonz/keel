// fast-check generators for two-sided histories over a tiny path vocabulary,
// so that collisions (same path, dir/file, rename targets) are common.

import fc from "fast-check";
import type { CommitPlan, FileSpec, TreeModel } from "./git-harness";

const DIRS = ["", "a", "a/c", "b"];
const NAMES = ["x", "y", "z", "w"];
export const PATHS = DIRS.flatMap((d) => NAMES.map((n) => (d ? `${d}/${n}` : n)));
/** File paths that coincide with directories above: dir/file clashes. */
const CLASH_PATHS = ["a", "a/c", "b"];

const LINES = Array.from({ length: 24 }, (_, i) => `line ${i}: ${"lorem ipsum dolor ".repeat(1 + (i % 3))}`);
const SUBMODULE_SHAS = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];

const pathArb = fc.oneof(
  { weight: 29, arbitrary: fc.constantFrom(...PATHS) },
  { weight: 1, arbitrary: fc.constantFrom(...CLASH_PATHS) },
);
const linesArb = fc.array(fc.nat({ max: LINES.length - 1 }), { minLength: 4, maxLength: 12 });
const render = (ls: number[]) => `${ls.map((i) => LINES[i]).join("\n")}\n`;

export type Op =
  | { k: "add"; path: string; lines: number[] }
  | { k: "modify"; pick: number; lines: number[] }
  | { k: "edit"; pick: number; at: number; line: number }
  | { k: "delete"; pick: number }
  | { k: "rename"; pick: number; to: string }
  | { k: "nearRename"; pick: number; to: string; at: number; line: number }
  | { k: "chmod"; pick: number }
  | { k: "symlink"; path: string; target: string }
  | { k: "binary"; path: string; bytes: number[] }
  | { k: "gitlink"; path: string; sha: string };

const pick = fc.nat({ max: 63 });
const textOps = [
  { weight: 3, arbitrary: fc.record({ k: fc.constant("add" as const), path: pathArb, lines: linesArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("modify" as const), pick, lines: linesArb }) },
  {
    weight: 3,
    arbitrary: fc.record({ k: fc.constant("edit" as const), pick, at: fc.nat({ max: 11 }), line: fc.nat({ max: 23 }) }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("delete" as const), pick }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("rename" as const), pick, to: pathArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("nearRename" as const),
      pick,
      to: pathArb,
      at: fc.nat({ max: 11 }),
      line: fc.nat({ max: 23 }),
    }),
  },
];
const exoticOps = [
  { weight: 1, arbitrary: fc.record({ k: fc.constant("chmod" as const), pick }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("symlink" as const), path: pathArb, target: fc.constantFrom("x", "../y", "a/c") }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("binary" as const),
      path: pathArb,
      bytes: fc.array(fc.nat({ max: 255 }), { minLength: 1, maxLength: 40 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("gitlink" as const), path: pathArb, sha: fc.constantFrom(...SUBMODULE_SHAS) }),
  },
];
/** Plain text edits only: the cases where a path-level merge can actually succeed. */
export const textOpArb: fc.Arbitrary<Op> = fc.oneof(...(textOps as fc.WeightedArbitrary<Op>[]));
/** Everything, including modes, symlinks, binaries and submodules. */
export const anyOpArb: fc.Arbitrary<Op> = fc.oneof(...([...textOps, ...exoticOps] as fc.WeightedArbitrary<Op>[]));

export interface History {
  base: Array<{ path: string; lines: number[] }>;
  shared: Op[];
  ours: Op[];
  theirs: Op[];
  /** When set, ours and theirs are cross-merges of two branches off base. */
  crissCross: { a: Op[]; c: Op[] } | null;
}

const historyOf = (opArb: fc.Arbitrary<Op>, maxOps: number, baseMax: number): fc.Arbitrary<History> =>
  fc.record({
    base: fc.array(fc.record({ path: pathArb, lines: linesArb }), { minLength: 2, maxLength: baseMax }),
    shared: fc.array(opArb, { maxLength: 2 }),
    ours: fc.array(opArb, { maxLength: maxOps }),
    theirs: fc.array(opArb, { maxLength: maxOps }),
    // About one case in ten is a criss-cross (two merge bases).
    crissCross: fc.oneof(
      { weight: 9, arbitrary: fc.constant(null) },
      {
        weight: 1,
        arbitrary: fc.record({
          a: fc.array(opArb, { minLength: 1, maxLength: 2 }),
          c: fc.array(opArb, { minLength: 1, maxLength: 2 }),
        }),
      },
    ),
  });

export const historyArb: fc.Arbitrary<History> = fc.oneof(
  // Collision-heavy text edits, a sparser mostly-disjoint mix, and everything.
  { weight: 2, arbitrary: historyOf(textOpArb, 4, 6) },
  { weight: 2, arbitrary: historyOf(textOpArb, 2, 10) },
  { weight: 2, arbitrary: historyOf(anyOpArb, 4, 6) },
);

function setPath(t: TreeModel, path: string, f: FileSpec) {
  for (const k of t.keys()) if (k.startsWith(`${path}/`)) t.delete(k);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) t.delete(parts.slice(0, i).join("/"));
  t.set(path, f);
}

function textOf(f: FileSpec): string {
  return typeof f.data === "string" ? f.data : "";
}

export function applyOps(start: TreeModel, ops: readonly Op[]): TreeModel {
  const t = new Map(start);
  for (const op of ops) {
    const keys = [...t.keys()].sort();
    const at = (n: number) => (keys.length ? (keys[n % keys.length] as string) : null);
    switch (op.k) {
      case "add":
        setPath(t, op.path, { mode: "100644", data: render(op.lines) });
        break;
      case "modify": {
        const p = at(op.pick);
        if (p) setPath(t, p, { mode: t.get(p)?.mode === "100755" ? "100755" : "100644", data: render(op.lines) });
        break;
      }
      case "edit": {
        const p = at(op.pick);
        const f = p ? t.get(p) : undefined;
        if (p && f && (f.mode === "100644" || f.mode === "100755") && typeof f.data === "string") {
          const ls = f.data.split("\n");
          ls[op.at % Math.max(1, ls.length - 1)] = `${LINES[op.line]} edited`;
          t.set(p, { mode: f.mode, data: ls.join("\n") });
        }
        break;
      }
      case "delete": {
        const p = at(op.pick);
        if (p) t.delete(p);
        break;
      }
      case "rename":
      case "nearRename": {
        const p = at(op.pick);
        const f = p ? t.get(p) : undefined;
        if (!p || !f || p === op.to) break;
        t.delete(p);
        let data = f.data;
        if (op.k === "nearRename" && typeof data === "string" && f.mode !== "120000" && f.mode !== "160000") {
          const ls = textOf(f).split("\n");
          ls[op.at % Math.max(1, ls.length - 1)] = `${LINES[op.line]} tweaked`;
          data = ls.join("\n");
        }
        setPath(t, op.to, { mode: f.mode, data });
        break;
      }
      case "chmod": {
        const p = at(op.pick);
        const f = p ? t.get(p) : undefined;
        if (p && f && (f.mode === "100644" || f.mode === "100755")) {
          t.set(p, { mode: f.mode === "100644" ? "100755" : "100644", data: f.data });
        }
        break;
      }
      case "symlink":
        setPath(t, op.path, { mode: "120000", data: op.target });
        break;
      case "binary":
        setPath(t, op.path, { mode: "100644", data: new Uint8Array([0, ...op.bytes]) });
        break;
      case "gitlink":
        setPath(t, op.path, { mode: "160000", data: op.sha });
        break;
    }
  }
  return t;
}

export interface CasePlan {
  commits: CommitPlan[];
  oursMark: number;
  theirsMark: number;
}

export function planCase(h: History, id: number): CasePlan {
  const base = new Map<string, FileSpec>();
  for (const f of h.base) setPath(base, f.path, { mode: "100644", data: render(f.lines) });
  const ref = (n: string) => `refs/heads/c${id}/${n}`;
  if (!h.crissCross) {
    return {
      commits: [
        { mark: 1, ref: ref("base"), parents: [], tree: base, message: "base\n" },
        { mark: 2, ref: ref("ours"), parents: [1], tree: applyOps(base, [...h.shared, ...h.ours]), message: "ours\n" },
        { mark: 3, ref: ref("theirs"), parents: [1], tree: applyOps(base, [...h.shared, ...h.theirs]), message: "theirs\n" },
      ],
      oursMark: 2,
      theirsMark: 3,
    };
  }
  const a = applyOps(base, h.crissCross.a);
  const c = applyOps(base, h.crissCross.c);
  return {
    commits: [
      { mark: 1, ref: ref("base"), parents: [], tree: base, message: "base\n" },
      { mark: 2, ref: ref("a"), parents: [1], tree: a, message: "a\n" },
      { mark: 3, ref: ref("c"), parents: [1], tree: c, message: "c\n" },
      { mark: 4, ref: ref("ours"), parents: [2, 3], tree: applyOps(a, [...h.shared, ...h.ours]), message: "ours\n" },
      { mark: 5, ref: ref("theirs"), parents: [3, 2], tree: applyOps(c, [...h.shared, ...h.theirs]), message: "theirs\n" },
    ],
    oursMark: 4,
    theirsMark: 5,
  };
}
