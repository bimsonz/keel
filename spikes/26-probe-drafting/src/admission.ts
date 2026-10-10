// The admission rule for a drafted probe over the world matrix, and the
// vacuity check against mutant A.
//
// Admitted means: pass in A (the premise holder's world), fail in A+B, n/a on
// base and in B (the precondition is absent), each over exactly three runs on
// fresh isolates with the same outcome every time. Any harness error (exit 2)
// or bundle error in a matrix world rejects the draft.
import type { Outcome, RunResult } from "./outcome.ts";

export const MATRIX = ["base", "A", "B", "AB"] as const;
export type MatrixWorld = (typeof MATRIX)[number];
export const EXPECTED: Readonly<Record<MatrixWorld, Outcome>> = { base: "n/a", A: "pass", B: "n/a", AB: "fail" };
export const RUNS = 3;

export interface WorldEvaluation {
  world: string;
  bundleError?: string;
  runs: RunResult[];
}

export interface Cell {
  expected: Outcome;
  observed: string[];
  stable: boolean;
  ok: boolean;
}

export type FailureMode = "compile-error" | "harness-error" | "flaky" | "n/a-mishandled" | "wrong-world-behaviour";

export interface Admission {
  admitted: boolean;
  cells: Record<string, Cell>;
  /** Every way the draft misses the rule, most basic first. Empty when admitted. */
  failures: FailureMode[];
  detail: string[];
}

function label(r: RunResult): string {
  return r.exit === 2 ? "harness-error" : r.outcome;
}

export function admit(evals: readonly WorldEvaluation[]): Admission {
  const byWorld = new Map(evals.map((e) => [e.world, e]));
  const cells: Record<string, Cell> = {};
  const failures = new Set<FailureMode>();
  const detail: string[] = [];
  for (const world of MATRIX) {
    const expected = EXPECTED[world];
    const e = byWorld.get(world);
    if (e === undefined) {
      cells[world] = { expected, observed: [], stable: false, ok: false };
      failures.add("harness-error");
      detail.push(`${world}: not evaluated`);
      continue;
    }
    if (e.bundleError !== undefined) {
      cells[world] = { expected, observed: ["compile-error"], stable: false, ok: false };
      failures.add("compile-error");
      detail.push(`${world}: bundle error`);
      continue;
    }
    const observed = e.runs.map(label);
    const stable = observed.length === RUNS && observed.every((o) => o === observed[0]);
    const ok = stable && observed[0] === expected;
    cells[world] = { expected, observed, stable, ok };
    if (ok) continue;
    if (observed.includes("harness-error")) failures.add("harness-error");
    if (observed.length !== RUNS) detail.push(`${world}: ${observed.length} runs, need ${RUNS}`);
    if (!stable && new Set(observed).size > 1) {
      failures.add("flaky");
      detail.push(`${world}: unstable ${observed.join("/")}`);
    }
    const wrong = observed.filter((o) => o !== expected && o !== "harness-error");
    if (wrong.length > 0) {
      // n/a is mishandled when an absent precondition is not reported as n/a,
      // or when n/a is reported where the precondition is present.
      const naMishandled = expected === "n/a" || wrong.includes("n/a");
      failures.add(naMishandled ? "n/a-mishandled" : "wrong-world-behaviour");
      detail.push(`${world}: expected ${expected}, observed ${observed.join("/")}`);
    }
  }
  const order: FailureMode[] = ["compile-error", "harness-error", "flaky", "n/a-mishandled", "wrong-world-behaviour"];
  const list = order.filter((f) => failures.has(f));
  return { admitted: list.length === 0 && Object.values(cells).every((c) => c.ok), cells, failures: list, detail };
}

export interface Vacuity {
  /** True when the draft does not fail against mutant A (the revoke is a no-op there). */
  vacuous: boolean;
  observed: string[];
  why?: string;
}

/** A non-vacuous probe must fail, every run, in the world where the revoke removes nothing. */
export function vacuity(mutant: WorldEvaluation | undefined): Vacuity {
  if (mutant === undefined) return { vacuous: true, observed: [], why: "mutant A not evaluated" };
  if (mutant.bundleError !== undefined) return { vacuous: true, observed: ["compile-error"], why: "does not bundle against mutant A" };
  const observed = mutant.runs.map(label);
  if (observed.length === RUNS && observed.every((o) => o === "fail")) return { vacuous: false, observed };
  const why = observed.includes("pass")
    ? "passes with the revoke step removed"
    : `expected fail ×${RUNS} with the revoke removed, observed ${observed.join("/")}`;
  return { vacuous: true, observed, why };
}

/** Wilson score interval for k successes in n trials (95%). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
