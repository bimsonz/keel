import type { ChangeId } from "../kernel/index.ts";

export type BatchMember = { readonly id: ChangeId; readonly affected: readonly string[] };

export type Attribution = {
  readonly suspects: readonly ChangeId[];
  /** No member's Affected set contains the check: the dependency graph is missing an edge. */
  readonly graphGap: boolean;
  readonly next:
    | { readonly _tag: "culprit"; readonly id: ChangeId }
    | { readonly _tag: "leave-one-out"; readonly trials: readonly { readonly without: ChangeId; readonly members: readonly ChangeId[] }[] }
    | { readonly _tag: "none" };
};

/**
 * Targeted attribution for a failing check: the suspects are the members
 * whose Affected set contains it (all members if none does, which reveals a
 * graph gap). One suspect is the culprit; several are tried leave-one-out.
 */
export const attribute = (failingCheck: string, members: readonly BatchMember[]): Attribution => {
  const touching = members.filter((m) => m.affected.includes(failingCheck));
  const graphGap = touching.length === 0;
  const suspects = (graphGap ? members : touching).map((m) => m.id);
  const [only] = suspects;
  const next: Attribution["next"] =
    suspects.length === 0
      ? { _tag: "none" }
      : suspects.length === 1 && only !== undefined
        ? { _tag: "culprit", id: only }
        : {
            _tag: "leave-one-out",
            trials: suspects.map((without) => ({ without, members: members.map((m) => m.id).filter((id) => id !== without) })),
          };
  return { suspects, graphGap, next };
};

export type LeaveOneOutResult = { readonly without: ChangeId; readonly passed: boolean };

export type Finding =
  | { readonly _tag: "culprit"; readonly id: ChangeId }
  /** Every leave-one-out trial passes while the union fails: the members only break together. */
  | { readonly _tag: "interaction"; readonly parties: readonly ChangeId[] }
  /** No single removal fixes it: split further. */
  | { readonly _tag: "inconclusive" };

/** Reads leave-one-out trials of a failing batch. */
export const interpretLeaveOneOut = (results: readonly LeaveOneOutResult[]): Finding => {
  const fixes = results.filter((r) => r.passed).map((r) => r.without);
  const [one] = fixes;
  if (results.length >= 2 && fixes.length === results.length) return { _tag: "interaction", parties: [...fixes].toSorted() };
  if (fixes.length === 1 && one !== undefined) return { _tag: "culprit", id: one };
  return { _tag: "inconclusive" };
};
