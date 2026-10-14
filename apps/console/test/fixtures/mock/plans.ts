// Verification Plans as Keel compiles them, and the lines its verdicts carry,
// for the fixtures' verdict views. Keel's `PlanCompiled` commits only how many
// steps a plan has; the plan itself is served with a verdict issued under it
// (`GET /v1/verdicts/{id}`). Each shape here is the one Keel's compiler and
// verifier write: `packages/core/src/application/verification/` (packs.ts,
// guards.ts, compile.ts's `tierFor`, verify-candidate.ts's `describe` and
// `CITED_AS`, verdict-index.ts's `verdictReasons`).

import type {
  Predicate,
  VerdictPlan,
  VerdictPlanStep,
  VerdictReason,
} from "../../../src/contract/keel/index.ts";

/** A project's own suite: every TypeScript project's plan has it. */
export const SUITE: VerdictPlanStep = {
  id: "js-ts.suite",
  kind: "deterministic",
  tier: 2,
  tierReason: "policy: project suites run in containers",
  evidenceCeiling: "proof",
  because: "applies to every change",
};

/** A Worker app's typecheck, whose pack pins it to a container. */
export const TYPECHECK: VerdictPlanStep = {
  id: "worker-app.typecheck",
  kind: "deterministic",
  tier: 2,
  tierReason: "pinned by the project's flow spec",
  evidenceCeiling: "proof",
  because: "applies to every change",
};

/**
 * The step an admitted guard adds to the plan of a change near the tenet it guards. A guard that holds an active
 * decision blocks whatever the project's policy for its predicate.
 */
export function guardStep(guard: {
  id: string;
  /** The tenet it guards, where the tenet has an id: the fixtures commit none. */
  tenet?: string;
  predicate: Predicate;
  probe: string;
  near: string;
  decision?: { id: string; summary: string };
}): VerdictPlanStep {
  return {
    id: `guard:${guard.id}`,
    kind: "probe",
    tier: 1,
    tierReason: "policy: probes and pure checks run in isolates",
    evidenceCeiling: "proof",
    because: [
      guard.tenet === undefined ? `guards ${guard.id}` : `guards tenet ${guard.tenet}`,
      ...(guard.decision === undefined
        ? []
        : [`holds decision ${guard.decision.id}: ${guard.decision.summary}`]),
      `relies on or alters ${guard.near}, near ${guard.near}`,
    ].join("; "),
    guards: {
      predicate: guard.predicate,
      policy: guard.decision === undefined ? "advise" : "block",
      probe: guard.probe,
      ...(guard.decision === undefined ? {} : { decision: guard.decision }),
    },
  };
}

/** A plan by its hash, its steps in Keel's order. */
export const planOf = (hash: string, steps: VerdictPlanStep[]): VerdictPlan => ({ hash, steps });

/**
 * One result as a verdict's evidence describes it. A guard's report gives the tier its own reason, naming the
 * predicate and the probe; every other step's report copies the plan's.
 */
export function described(
  step: VerdictPlanStep,
  outcome: "pass" | "fail",
  evidence: string,
): string {
  const reason =
    step.guards === undefined
      ? step.tierReason
      : `guards ${step.guards.predicate} with its admitted probe ${step.guards.probe}`;
  return `${step.id}: ${outcome} (${step.evidenceCeiling}, tier ${step.tier}: ${reason}) evidence ${evidence}`;
}

/**
 * The step a line of a verdict's evidence names, as Keel's `verdictReasons` finds it: a result's line opens with
 * its step's id and a colon, and a guard's citation names its step after its heading. A line that names none is
 * proof, since a verifier reports only what ran.
 */
export function reasonOf(line: string, steps: readonly VerdictPlanStep[]): VerdictReason {
  const step = steps.find(
    (s) => line.startsWith(`${s.id}: `) || line.startsWith(`guard failed: ${s.id} (`),
  );
  return step === undefined
    ? { line, class: "proof" }
    : { line, step: step.id, class: step.evidenceCeiling };
}
