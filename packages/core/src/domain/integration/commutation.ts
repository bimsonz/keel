import { subjectsRelated, type SubjectKey } from "../coordination/index.ts";
import {
  type BatchId,
  type ChangeId,
  type CommitSha,
  type ContentHash,
  contentHashOf,
  type Glob,
  matchesGlob,
} from "../kernel/index.ts";

/** One side of a commutation check: what a batch (or the changes that landed since its base) touched. */
export type Footprints = {
  readonly changes: readonly ChangeId[];
  /** Δ: the paths changed. */
  readonly paths: readonly string[];
  /** Affected: the closure of reverse dependencies, tests and guards included. */
  readonly affected: readonly string[];
  /** The subjects the changes alter or rely on. */
  readonly subjects: readonly SubjectKey[];
};

export type CommutationInput = {
  /** Batch B, verified at `base` on top of its speculative predecessors P. */
  readonly batch: { readonly id: BatchId; readonly base: CommitSha; readonly predecessors: readonly ChangeId[]; readonly touched: Footprints };
  /** D: the changes that landed on trunk since `base` and are not in P. */
  readonly intervening: Footprints;
  /** The current head B would be promoted onto. */
  readonly head: CommitSha;
  readonly promoted: readonly ChangeId[];
  /** GitCore's merge-tree of B onto head was clean. */
  readonly mergeTreeClean: boolean;
  /** Lockfiles, root config, `.keel/policy/**`: touching one invalidates every proof. */
  readonly barriers: readonly Glob[];
  /** Other batches promoted in the same group commit. */
  readonly group: readonly { readonly id: BatchId; readonly touched: Footprints }[];
};

export type CommutationCondition = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

export type Commutation =
  /** B lands on the moved head without re-verification; `proofId` is the evidence. */
  | { readonly _tag: "commutes"; readonly proofId: ContentHash }
  /** A predecessor has not been promoted yet. */
  | { readonly _tag: "wait"; readonly unpromoted: readonly ChangeId[] }
  /** Re-verify, either everything or only where B and D meet. */
  | {
      readonly _tag: "reverify";
      readonly failed: readonly CommutationCondition[];
      readonly scope:
        | { readonly _tag: "all" }
        | { readonly _tag: "where-they-meet"; readonly affected: readonly string[]; readonly subjects: readonly SubjectKey[] };
    };

const sorted = <T extends string>(xs: readonly T[]): readonly T[] => [...new Set(xs)].toSorted();
const meet = (a: readonly string[], b: readonly string[]): readonly string[] => sorted(a.filter((x) => b.includes(x)));
const linking = (a: readonly SubjectKey[], b: readonly SubjectKey[]): readonly SubjectKey[] =>
  sorted([...a.filter((x) => b.some((y) => subjectsRelated(x, y))), ...b.filter((y) => a.some((x) => subjectsRelated(x, y)))]);

/** C2's path half, C3 and C4 for one pair of footprints. */
const pairwise = (x: Footprints, y: Footprints) => ({
  paths: meet(x.paths, y.paths),
  affected: meet(x.affected, y.affected),
  subjects: linking(x.subjects, y.subjects),
});

const canonicalFootprints = (f: Footprints) => ({
  changes: sorted(f.changes),
  paths: sorted(f.paths),
  affected: sorted(f.affected),
  subjects: sorted(f.subjects),
});

/**
 * Proof-Id: the content address of everything C1–C6 were decided on. Trunk's
 * server accepts any rewrite whose old oid matches, so this proof is Keel's
 * only guarantee that a promoted group was verified. It is deterministic and
 * independent of the order its inputs arrive in.
 */
export const proofIdOf = (input: CommutationInput): ContentHash =>
  contentHashOf({
    rule: "commutation/1",
    batch: { id: input.batch.id, base: input.batch.base, predecessors: sorted(input.batch.predecessors), touched: canonicalFootprints(input.batch.touched) },
    intervening: canonicalFootprints(input.intervening),
    head: input.head,
    promoted: sorted(input.promoted.filter((c) => input.batch.predecessors.includes(c))),
    mergeTreeClean: input.mergeTreeClean,
    barriers: sorted(input.barriers),
    group: input.group
      .map((g) => ({ id: g.id, touched: canonicalFootprints(g.touched) }))
      .map((g) => [JSON.stringify(g), g] as const)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, g]) => g),
  });

/**
 * The commutation rule: batch B, verified at its base, may be promoted onto a
 * head that has moved without being rebuilt only if
 *   C1 every predecessor in P has been promoted;
 *   C2 B and D touch disjoint paths and the merge-tree is clean;
 *   C3 Affected(B) and Affected(D) are disjoint;
 *   C4 no subject links B and D;
 *   C5 neither touches a barrier file;
 *   C6 C2–C4 hold for every pair in the group.
 * A barrier or an unclean merge means re-verifying everything; otherwise only
 * where B and D meet is re-verified.
 */
export const commutation = (input: CommutationInput): Commutation => {
  const unpromoted = input.batch.predecessors.filter((c) => !input.promoted.includes(c));
  if (unpromoted.length > 0) return { _tag: "wait", unpromoted: sorted(unpromoted) };

  const b = input.batch.touched;
  const d = input.intervening;
  const bd = pairwise(b, d);
  const members = [b, ...input.group.map((g) => g.touched)];
  const pairs = members.flatMap((x, i) => members.slice(i + 1).map((y) => pairwise(x, y)));
  const barrierTouched = [...b.paths, ...d.paths].some((p) => input.barriers.some((g) => matchesGlob(g, p)));

  const failed: CommutationCondition[] = [];
  if (bd.paths.length > 0 || !input.mergeTreeClean) failed.push("C2");
  if (bd.affected.length > 0) failed.push("C3");
  if (bd.subjects.length > 0) failed.push("C4");
  if (barrierTouched) failed.push("C5");
  if (pairs.some((p) => p.paths.length > 0 || p.affected.length > 0 || p.subjects.length > 0)) failed.push("C6");

  if (failed.length === 0) return { _tag: "commutes", proofId: proofIdOf(input) };
  if (barrierTouched || !input.mergeTreeClean) return { _tag: "reverify", failed, scope: { _tag: "all" } };
  return {
    _tag: "reverify",
    failed,
    scope: {
      _tag: "where-they-meet",
      affected: sorted([...bd.affected, ...pairs.flatMap((p) => p.affected)]),
      subjects: sorted([...bd.subjects, ...pairs.flatMap((p) => p.subjects)]),
    },
  };
};
