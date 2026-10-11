import { Clock, Effect } from "effect";
import type { ContentHash } from "../../domain/kernel/index.ts";
import type { PlanStep, StepReport } from "../../domain/verification/index.ts";
import { ProbeRunner } from "../ports/index.ts";
import type { StepRunner } from "./run-plan.ts";

/**
 * A plan's step runner with its guard steps mounted: a step that
 * guards a tenet runs the probe its plan pins (`step.guards.probe`, fetched by
 * that hash and checked against it) against the candidate, in a fresh Tier 1
 * isolate. It never runs the candidate's own `.keel/guards/` copy, which the
 * VerifierDO drops. Every other step goes to `otherwise`.
 *
 * The probe's pass and fail are reported as they are. Its n/a is reported as
 * n/a, which `coerce` reads as abstain: the tenet's precondition is gone. A
 * harness error, or a runner that could not run the probe at all, is an
 * infra failure, so it abstains too; neither is ever a pass.
 */
export const withGuards =
  <R>(candidate: ContentHash, otherwise: StepRunner<R>): StepRunner<R | ProbeRunner> =>
  (step, world) => {
    const guards = step.guards;
    if (guards === undefined) return otherwise(step, world);
    return Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const run = yield* (yield* ProbeRunner)
        .run({ probe: guards.probe, world: world ?? "AB", worldBundle: candidate, run: 1 })
        .pipe(
          Effect.catchTag("ProbeRunnerUnavailable", (e) =>
            Effect.succeed({ _tag: "unavailable", reason: e.reason } as const),
          ),
        );
      const report = (outcome: string, failure?: StepReport["failure"]): StepReport => ({
        stepId: step.id,
        outcome,
        evidenceClass: evidenceOf(step),
        tier: {
          tier: 1,
          reason: `guards ${guards.predicate} with its admitted probe ${guards.probe}`,
        },
        durationMs: 0,
        resultRef: guards.probe,
        ...(world === undefined ? {} : { world }),
        ...(failure === undefined ? {} : { failure }),
      });
      const finished = yield* Clock.currentTimeMillis;
      const durationMs = finished - started;
      if (run._tag === "ran") return { ...report(run.outcome), durationMs };
      if (run._tag === "harness-error") return { ...report("abstain", "schema"), durationMs };
      return { ...report("abstain", "unavailable"), durationMs };
    });
  };

/** The evidence a guard's probe gives: as strong as the step allows, which coerce caps anyway. */
const evidenceOf = (step: PlanStep) => step.effectiveClass ?? step.evidenceCeiling;
