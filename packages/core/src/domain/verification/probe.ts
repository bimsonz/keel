import type { World } from "./conflict.ts";

/** A probe's answer in one world. `n/a`: the probe's precondition is absent there; it is never a pass. */
export type ProbeOutcome = "pass" | "fail" | "n/a";

/** One cell of the world matrix: a probe's outcome in one world, on one calibration run. */
export type ProbeCell = {
  readonly world: World;
  readonly run: number;
  readonly outcome: ProbeOutcome;
};

/** How many consecutive discriminating runs admission needs. */
export const ADMISSION_RUNS = 3;

export type Admission =
  | { readonly _tag: "admitted"; readonly runs: number }
  | { readonly _tag: "pending"; readonly complete: number }
  | { readonly _tag: "rejected"; readonly reason: "non-discriminating" | "unstable" };

type Run = {
  readonly trunk?: ProbeOutcome;
  readonly holder?: ProbeOutcome;
  readonly combined?: ProbeOutcome;
};

/**
 * A run discriminates when the probe passes on trunk (or does not apply
 * there), passes in the premise-holder's world (A), and fails in the
 * combined world (AB). World B is recorded but does not decide.
 */
const discriminates = (r: Required<Run>): boolean =>
  (r.trunk === "pass" || r.trunk === "n/a") && r.holder === "pass" && r.combined === "fail";

const complete = (r: Run): r is Required<Run> =>
  r.trunk !== undefined && r.holder !== undefined && r.combined !== undefined;

/**
 * Probe admission from the world-matrix cells. A probe becomes a guard only
 * when at least three complete runs all discriminate. A probe that never
 * discriminates (n/a, or the same answer everywhere) is dismissed as
 * non-discriminating; one that discriminates on some runs but not others is
 * unstable, and never admitted. Until three runs complete it is pending.
 */
export const admit = (cells: readonly ProbeCell[]): Admission => {
  const runs = new Map<number, Run>();
  for (const cell of cells) {
    const r = runs.get(cell.run) ?? {};
    if (cell.world === "trunk") runs.set(cell.run, { ...r, trunk: cell.outcome });
    else if (cell.world === "A") runs.set(cell.run, { ...r, holder: cell.outcome });
    else if (cell.world === "AB") runs.set(cell.run, { ...r, combined: cell.outcome });
  }
  const done = [...runs.values()].filter(complete);
  const good = done.filter(discriminates).length;
  if (good < done.length)
    return { _tag: "rejected", reason: good === 0 ? "non-discriminating" : "unstable" };
  return done.length >= ADMISSION_RUNS
    ? { _tag: "admitted", runs: done.length }
    : { _tag: "pending", complete: done.length };
};
