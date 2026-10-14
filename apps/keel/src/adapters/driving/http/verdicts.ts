import { projectNamespace, verdictReasons } from "@keeltown/core/application/verification";
import type { FlowPlan, PlanStep } from "@keeltown/core/domain/verification";
import { VerdictId } from "@keeltown/core/kernel";
import { type IndexedVerdict, PlanStore, Verdicts } from "@keeltown/core/ports";
import { Effect } from "effect";
import type { Operations, Views_getVerdictResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { projectIn } from "./decisions.ts";
import { problem } from "./problems.ts";
import type { Runner } from "./run.ts";

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];

const iso = (ms: number) => new Date(ms).toISOString();

const stepView = (s: PlanStep) => ({
  id: s.id,
  kind: s.kind,
  tier: s.tier.tier,
  tierReason: s.tier.reason,
  evidenceCeiling: s.evidenceCeiling,
  because: s.because,
  ...(s.guards === undefined
    ? {}
    : {
        guards: {
          predicate: s.guards.predicate,
          policy: s.guards.policy,
          probe: s.guards.probe,
          ...(s.guards.decision === undefined
            ? {}
            : { decision: { id: s.guards.decision.id, summary: s.guards.decision.summary } }),
        },
      }),
});

/** A verdict as the API serves it: its evidence line by line, and the plan it was issued under when that is stored. */
export const verdictView = (v: IndexedVerdict, plan: FlowPlan | undefined) => ({
  id: v.verdict.verdictId,
  outcome: v.verdict.outcome,
  reasons: verdictReasons(v.verdict.evidence, plan?.steps ?? []).map((r) => ({
    line: r.line,
    ...(r.step === undefined ? {} : { step: r.step }),
    class: r.class,
  })),
  issuedAt: iso(v.issuedAt),
  ...(plan === undefined ? {} : { plan: { hash: plan.planHash, steps: plan.steps.map(stepView) } }),
});

export function verdictNotFound(caller: { readonly requestId: string }, verdictId: string) {
  return {
    status: 404 as const,
    body: problem(404, "verdict.not_found", caller.requestId, {
      detail: `No verdict ${verdictId} in a project you can read.`,
      nextActions: [],
    }),
  };
}

/**
 * The plan a verdict was issued under, from the project's namespace by the
 * verdict's plan hash and checked against it. None for a verdict reached with
 * no plan, or one whose plan is not stored (or whose project has no place).
 * A plan that does not rehash to its hash is a defect, never served.
 */
const planOf = (v: IndexedVerdict) => {
  const hash = v.verdict.planHash;
  if (hash === undefined) return Effect.succeed(undefined);
  return projectNamespace(v.project).pipe(
    Effect.flatMap((namespace) => PlanStore.use((plans) => plans.get(namespace, hash))),
    Effect.map((plan): FlowPlan | undefined => plan),
    Effect.catchTags({
      PlanMissing: () => Effect.succeed(undefined),
      ProjectUnplaced: () => Effect.succeed(undefined),
    }),
    Effect.orDie,
  );
};

/**
 * Keel's verdicts, by id alone, from the Projector's verdict index. The
 * policy decided the read on the verdict's own project; one in any other
 * project is not found, as one that does not exist is.
 */
export function verdictHandlers(run: Runner) {
  return {
    Views_getVerdict: (caller: Caller, input: Input<"Views_getVerdict">) =>
      run(
        caller,
        Verdicts.use((verdicts) => verdicts.get(VerdictId.make(input.verdictId))).pipe(
          Effect.flatMap((v) =>
            v.project === projectIn(caller).projectId
              ? planOf(v).pipe(
                  Effect.map((plan): Views_getVerdictResult => ({
                    status: 200,
                    body: verdictView(v, plan),
                  })),
                )
              : Effect.succeed(verdictNotFound(caller, input.verdictId)),
          ),
          Effect.catchTag("VerdictNotFound", () =>
            Effect.succeed(verdictNotFound(caller, input.verdictId)),
          ),
        ),
      ),
  };
}
