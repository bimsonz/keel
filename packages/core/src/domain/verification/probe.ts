import { Schema } from "effect";
import {
  ConflictId,
  ContentHash,
  DecisionId,
  GuardId,
  InstantSchema,
  ProbeId,
} from "../kernel/index.ts";
import { World } from "./conflict.ts";

/** A probe's answer in one world. `n/a`: the probe's precondition is absent there; it is never a pass. */
export const ProbeOutcome = Schema.Literals(["pass", "fail", "n/a"]);
export type ProbeOutcome = typeof ProbeOutcome.Type;

/** One cell of the world matrix: a probe's outcome in one world, on one calibration run. */
export const ProbeCell = Schema.Struct({
  world: World,
  run: Schema.Int,
  outcome: ProbeOutcome,
});
export type ProbeCell = typeof ProbeCell.Type;

/** How many consecutive discriminating runs admission needs; calibration runs are numbered 1 to this. */
export const ADMISSION_RUNS = 3;

/**
 * How many drafts a probe gets before its conflict is unprovable (the bounded
 * repair loop): the first draft and three repairs, as `DRAFT_REPAIRS` sets them.
 */
export const MAX_DRAFT_ATTEMPTS = 4;

export const ProbeState = Schema.Literals(["calibrating", "admitted", "discarded", "retired"]);
export type ProbeState = typeof ProbeState.Type;

export const DiscardReason = Schema.Literals(["non-discriminating", "unstable", "draft-failed"]);
export type DiscardReason = typeof DiscardReason.Type;

/** A probe, and once admitted the guard it becomes (state-machines.md § Probe → Guard). */
export const Probe = Schema.Struct({
  id: ProbeId,
  conflictId: ConflictId,
  state: ProbeState,
  /** Absent only for a probe whose drafts all failed. */
  attempts: Schema.optional(Schema.Int),
  bundleHash: Schema.optional(ContentHash),
  cells: Schema.Array(ProbeCell),
  guardId: Schema.optional(GuardId),
  discarded: Schema.optional(DiscardReason),
  retiredBy: Schema.optional(DecisionId),
  createdAt: InstantSchema,
});
export type Probe = typeof Probe.Type;

export type Admission =
  | { readonly _tag: "admitted"; readonly runs: number }
  | { readonly _tag: "pending"; readonly complete: number }
  | { readonly _tag: "rejected"; readonly reason: "non-discriminating" | "unstable" };

type Run = {
  readonly trunk?: ProbeOutcome;
  readonly holder?: ProbeOutcome;
  readonly combined?: ProbeOutcome;
  readonly noop?: ProbeOutcome;
};

/**
 * A run discriminates when the probe passes on trunk (or does not apply
 * there), passes in the premise-holder's world (A), fails in the combined
 * world (AB), and fails in A-noop, the holder's world with the premised
 * behaviour removed. A pass or `n/a` in A-noop means the probe never tested
 * the premise (spike S26: a probe that only counted store lookups passed the
 * whole matrix). World B is recorded but does not decide.
 */
const discriminates = (r: Required<Run>): boolean =>
  (r.trunk === "pass" || r.trunk === "n/a") &&
  r.holder === "pass" &&
  r.combined === "fail" &&
  r.noop === "fail";

const complete = (r: Run): r is Required<Run> =>
  r.trunk !== undefined &&
  r.holder !== undefined &&
  r.combined !== undefined &&
  r.noop !== undefined;

/**
 * Probe admission from the world-matrix cells. A probe becomes a guard only
 * when at least three complete runs all discriminate. A probe that never
 * discriminates (n/a, the same answer everywhere, or a pass against the
 * do-nothing mutant) is dismissed as non-discriminating; one that
 * discriminates on some runs but not others is unstable, and never admitted.
 * Until three runs complete it is pending. A probe whose template cannot
 * build an A-noop world never completes a run, so it is never admitted.
 */
export const admit = (cells: readonly ProbeCell[]): Admission => {
  const runs = new Map<number, Run>();
  for (const cell of cells) {
    const r = runs.get(cell.run) ?? {};
    if (cell.world === "trunk") runs.set(cell.run, { ...r, trunk: cell.outcome });
    else if (cell.world === "A") runs.set(cell.run, { ...r, holder: cell.outcome });
    else if (cell.world === "AB") runs.set(cell.run, { ...r, combined: cell.outcome });
    else if (cell.world === "A-noop") runs.set(cell.run, { ...r, noop: cell.outcome });
  }
  const done = [...runs.values()].filter(complete);
  const good = done.filter(discriminates).length;
  if (good < done.length)
    return { _tag: "rejected", reason: good === 0 ? "non-discriminating" : "unstable" };
  return done.length >= ADMISSION_RUNS
    ? { _tag: "admitted", runs: done.length }
    : { _tag: "pending", complete: done.length };
};
