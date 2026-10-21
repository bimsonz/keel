import { Effect, Result } from "effect";
import type { SubjectKey } from "../../domain/coordination/index.ts";
import type {
  ChangeId,
  CommitSha,
  ConflictId,
  ContentHash,
  NamespaceId,
  ProjectId,
} from "../../domain/kernel/index.ts";
import {
  coerce,
  compile,
  type FlowPlan,
  type FlowWorld,
  type PlanStep,
  type ProbeOutcome,
  type StepReport,
} from "../../domain/verification/index.ts";
import { FlowSpecSource, PlanStore, ProbeLedger, type RepoRef } from "../ports/index.ts";
import { type DepsAnswer, depsStop } from "./deps.ts";
import { flowPolicyOf, flowSetup } from "./flow-spec.ts";
import { TIER2_STEP_IDS } from "./packs.ts";
import { type ProbeParties, worldChecks } from "./probe-conflict.ts";

/**
 * Where a check's plan comes from: trunk's, compiled from trunk head's flow
 * with no subjects; a party's own (`OfChange`), read from its Change when the
 * check runs, because the Probe reads a party the moment it submits, before
 * its Precheck has compiled; or why there is none, which the check records
 * as n/a.
 */
export type CheckPlan =
  | { readonly _tag: "Planned"; readonly planHash: ContentHash }
  | { readonly _tag: "OfChange"; readonly changeId: ChangeId }
  | { readonly _tag: "Unplanned"; readonly reason: string };

/** One party's suite to run in a world: `suite:trunk` or `suite:<changeId>`, and its plan. */
export interface PlannedCheck {
  readonly check: string;
  readonly plan: CheckPlan;
}

/** One KeelWorldCheck instance's work: the checks of one world of a conflict's matrix, run on that world's bundle. */
export interface WorldCheckJob {
  /** The namespace the project belongs to: where the world's bundle and the checks' plans and evidence are kept. */
  readonly namespace: NamespaceId;
  readonly projectId: ProjectId;
  readonly key: SubjectKey;
  readonly conflictId: ConflictId;
  readonly world: FlowWorld;
  readonly bundle: ContentHash;
  readonly checks: readonly PlannedCheck[];
}

/** One instance per world of a conflict: `world-<conflictId>-<world>`. */
export const worldCheckInstanceId = (conflictId: ConflictId, world: FlowWorld): string =>
  `world-${conflictId}-${world}`;

/**
 * The world checks a drafted conflict runs:
 * trunk's suite on trunk, each party's own suite in its world, and both in
 * AB, each on that world's bundle with the plan its party was verified
 * under, which the check's own instance reads. Grouped one job per world, in
 * matrix order.
 */
export const worldCheckJobs = (
  conflict: {
    readonly namespace: NamespaceId;
    readonly projectId: ProjectId;
    readonly key: SubjectKey;
    readonly conflictId: ConflictId;
  },
  parties: ProbeParties,
  worlds: Readonly<Record<FlowWorld, ContentHash>>,
  trunk: CheckPlan,
): readonly WorldCheckJob[] => {
  const planOf = (check: string): CheckPlan =>
    check === "suite:trunk"
      ? trunk
      : { _tag: "OfChange", changeId: check === `suite:${parties.A}` ? parties.A : parties.B };
  const specs = worldChecks(parties);
  return (["trunk", "A", "B", "AB"] as const).map((world) => ({
    ...conflict,
    world,
    bundle: worlds[world],
    checks: specs
      .filter((s) => s.world === world)
      .map((s) => ({ check: s.check, plan: planOf(s.check) })),
  }));
};

/**
 * The steps a world check runs: the plan's Tier 2 steps that KeelVerify
 * has a runner for, the change's existing suite among them, in plan order.
 * Guard steps never run here: a probe runs only in its own matrix.
 */
export const worldCheckSteps = (plan: FlowPlan): readonly PlanStep[] =>
  plan.steps.filter((step) => step.tier.tier === 2 && TIER2_STEP_IDS.includes(step.id));

/**
 * What one world's instance runs for all its checks: each check's steps, each
 * distinct step once, in the order first met. A step's runner command comes
 * from its pack, not its plan, so the same step on the same bundle answers
 * the same for every check (AB holds two): running it again would only cost
 * a container.
 */
export const worldCheckRunSteps = (plans: readonly FlowPlan[]): readonly PlanStep[] => {
  const steps = new Map<string, PlanStep>();
  for (const plan of plans)
    for (const step of worldCheckSteps(plan)) if (!steps.has(step.id)) steps.set(step.id, step);
  return [...steps.values()];
};

/** What a world check records: its outcome, and why when it could not say pass or fail. */
export interface WorldCheckOutcome {
  readonly outcome: ProbeOutcome;
  readonly reason?: string | undefined;
}

/**
 * One check's cell from its steps' reports, each read as the verdict reads it
 * (`coerce`): fail when any step fails, pass when every step passes, and n/a,
 * saying why, when the plan holds no such step or a step gave no answer. A
 * world handed no deps bundle asked no runner, so its cell gives the reason
 * its steps stopped for (`depsStop`): a refused install never reads as a
 * failed suite.
 */
export const worldCheckCell = (
  plan: FlowPlan,
  reports: readonly StepReport[],
  deps: DepsAnswer,
): WorldCheckOutcome => {
  const steps = worldCheckSteps(plan);
  const [first] = steps;
  if (first === undefined)
    return { outcome: "n/a", reason: "the plan holds no Tier 2 step Keel can run" };
  const stop = deps._tag === "DepsReady" ? undefined : depsStop(first, deps).evidence.why;
  const results = steps.map((step) => {
    const report = reports.find((r) => r.stepId === step.id);
    return { step, report, result: report === undefined ? undefined : coerce(plan, report) };
  });
  const failed = results.filter((r) => r.result?.outcome === "fail").map((r) => r.step.id);
  if (failed.length > 0)
    return {
      outcome: "fail",
      reason: `${failed.join(", ")} ${stop === undefined ? "failed" : `did not run: ${stop}`}`,
    };
  if (results.every((r) => r.result?.outcome === "pass")) return { outcome: "pass" };
  const quiet = results.filter((r) => r.result?.outcome !== "pass");
  if (stop !== undefined)
    return {
      outcome: "n/a",
      reason: `${quiet.map((r) => r.step.id).join(", ")} did not run: ${stop}`,
    };
  const silent = quiet.map((r) =>
    r.report === undefined
      ? `${r.step.id} did not run`
      : `${r.step.id} ${r.result?.outcome ?? "abstain"}${r.report.failure === undefined ? "" : ` (${r.report.failure})`}`,
  );
  return { outcome: "n/a", reason: silent.join("; ") };
};

/**
 * Trunk's check plan: the plan compiled from trunk head's flow, read
 * from staging, with no subjects and no guards, stored so the check runs it
 * by hash as KeelVerify runs a change's. A flow that cannot be read or does
 * not compile leaves trunk's check unplanned, saying why.
 */
export const trunkCheckPlan = (namespace: NamespaceId, staging: RepoRef, commit: CommitSha) =>
  Effect.gen(function* () {
    const sources = yield* Effect.result((yield* FlowSpecSource).read(staging, commit));
    if (Result.isFailure(sources))
      return {
        _tag: "Unplanned",
        reason: `trunk's flow at ${commit} could not be read: ${sources.failure._tag}`,
      } satisfies CheckPlan;
    const setup = flowSetup(sources.success, commit);
    if (Result.isFailure(setup))
      return {
        _tag: "Unplanned",
        reason: `trunk's flow at ${commit} is invalid: ${setup.failure.reason}`,
      } satisfies CheckPlan;
    const { definition, predicatePolicy, pack } = setup.success;
    const plan = compile(
      definition,
      {
        baseCommit: commit,
        touchedPaths: [],
        subjects: [],
        facts: {},
        predicatePolicy,
        admittedGuards: [],
      },
      pack.defaults,
      flowPolicyOf(setup.success),
    );
    if (Result.isFailure(plan))
      return {
        _tag: "Unplanned",
        reason: `trunk's flow at ${commit} does not compile: ${plan.failure.map((e) => e._tag).join(", ")}`,
      } satisfies CheckPlan;
    return {
      _tag: "Planned",
      planHash: yield* (yield* PlanStore).put(namespace, plan.success),
    } satisfies CheckPlan;
  });

/**
 * Records one check in the conflict's ledger: run 1, as each check runs once.
 * The ledger takes it while the conflict is probing and after its probe has
 * decided; a refusal means the conflict has
 * moved on, and is answered with its reason.
 */
export const recordWorldCheck = (job: WorldCheckJob, check: string, cell: WorldCheckOutcome) =>
  Effect.gen(function* () {
    const ledger = yield* ProbeLedger;
    return yield* ledger
      .worldCheckRan(
        { projectId: job.projectId, key: job.key },
        {
          conflictId: job.conflictId,
          world: job.world,
          check,
          run: 1,
          outcome: cell.outcome,
          ...(cell.reason === undefined ? {} : { reason: cell.reason }),
        },
      )
      .pipe(
        Effect.as({ _tag: "Recorded" } as const),
        Effect.catch((e) =>
          Effect.succeed({
            _tag: "Refused",
            reason:
              "reason" in e && typeof e.reason === "string" ? `${e._tag}: ${e.reason}` : e._tag,
          } as const),
        ),
      );
  });
