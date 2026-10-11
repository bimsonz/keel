import { Effect, Result, Schema } from "effect";
import {
  type ChangeId,
  type CommitSha,
  ContentHash,
  NextAction,
  type VerdictId,
} from "../../domain/kernel/index.ts";
import {
  compile,
  defaultFlowPolicy,
  GUARD_PATHS,
  HUMAN_CLASS_STEP,
  precheck,
  type PrecheckPolicy,
  type RefusedPath,
} from "../../domain/verification/index.ts";
import { ChangePrecheck, CodeHost, type PrecheckWorkspace, Projects } from "../ports/index.ts";
import { JS_TS_SUITE_PACK, L1_SUITE_PLAN } from "./packs.ts";

/**
 * Precheck's use-cases, one per Workflow step: start, diff, policy, then
 * refuse or compile. Each is safe to replay: the Change DO's writes are
 * idempotent by instance, and the reads answer the same thing twice. What
 * passes between steps is plain data, small enough for a step's output.
 */

/** The submission Precheck checks: `ChangeSubmitted`'s payload, and the Workflow instance checking it. */
export interface PrecheckSubmission {
  readonly changeId: ChangeId;
  readonly revision: number;
  readonly commitSha: CommitSha;
  readonly instanceId: string;
}

/** What Precheck decided: refuse the submission with reasons and next actions, or record its plan. */
export const PrecheckDecision = Schema.Union([
  Schema.TaggedStruct("Refuse", {
    reasons: Schema.NonEmptyArray(Schema.String),
    nextActions: Schema.NonEmptyArray(NextAction),
  }),
  Schema.TaggedStruct("Compile", {
    planHash: ContentHash,
    steps: Schema.Int,
    costEstimate: Schema.Number,
  }),
]);
export type PrecheckDecision = typeof PrecheckDecision.Type;

/** The paths the submission touches, or why they could not be read. */
export type TouchedPaths =
  | { readonly _tag: "Touched"; readonly paths: readonly string[] }
  | { readonly _tag: "Unreadable"; readonly reason: string };

const call = (s: PrecheckSubmission) => ({ revision: s.revision, instanceId: s.instanceId });

/** Marks the submission as being checked, then answers the workspace it was made in. */
export const startPrecheck = Effect.fn("verification/startPrecheck")(function* (
  submission: PrecheckSubmission,
) {
  const changes = yield* ChangePrecheck;
  yield* changes.started(submission.changeId, call(submission));
  return yield* changes.workspace(submission.changeId);
});

/**
 * The paths the submitted commit changes against the change's base (never
 * trunk's head). A workspace or commit the host cannot find is a refusal the
 * agent can act on, not a failure to retry.
 */
export const diffSubmission = Effect.fn("verification/diffSubmission")(function* (
  workspace: PrecheckWorkspace,
  commitSha: CommitSha,
) {
  const host = yield* CodeHost;
  return yield* host.diffTrees(workspace.repo, workspace.baseSha, commitSha).pipe(
    Effect.map((rows): TouchedPaths => ({ _tag: "Touched", paths: rows.map((r) => r.path) })),
    Effect.catchTags({
      RepoNotFound: (e) =>
        Effect.succeed<TouchedPaths>({
          _tag: "Unreadable",
          reason: `RepoNotFound ${e.repo.namespace}/${e.repo.name}`,
        }),
      ObjectNotFound: (e) =>
        Effect.succeed<TouchedPaths>({ _tag: "Unreadable", reason: `ObjectNotFound ${e.oid}` }),
    }),
  );
});

/** Precheck's policy, each fact from its one home: the project's protected globs, core's guard paths. */
export const precheckPolicy = Effect.fn("verification/precheckPolicy")(function* (
  workspace: PrecheckWorkspace,
) {
  const settings = yield* (yield* Projects).settings(workspace.projectId);
  const policy: PrecheckPolicy = {
    protectedPaths: settings.protectedPaths,
    guardPaths: GUARD_PATHS,
  };
  return policy;
});

const L1_STEPS = new Set(L1_SUITE_PLAN.steps.map((s) => s.id));

/** A refused path as the verdict's evidence cites it: the rule, the path and the glob that caught it. */
const reason = (p: RefusedPath) => `precheck:${p.rule}:${p.path} (${p.glob})`;

/**
 * The decision, a pure function of the steps' outputs: refuse guard and
 * protected paths, and a submission the diff could not read; otherwise
 * compile the plan from the base. Until D2.1 runs compiled plans, KeelVerify
 * runs only L1's static plan, so a plan needing any other step (today the
 * human-class gate a flow change adds) is refused rather than let through
 * without it.
 */
export const decidePrecheck = (
  touched: TouchedPaths,
  policy: PrecheckPolicy,
  baseSha: CommitSha,
): PrecheckDecision => {
  if (touched._tag === "Unreadable")
    return {
      _tag: "Refuse",
      reasons: [`precheck:unreadable:${touched.reason}`],
      nextActions: [
        {
          kind: "call",
          title:
            "Push the commit to the change's workspace again, on top of the base it was granted, then submit again",
          operationId: "submit",
        },
      ],
    };
  const checked = precheck(touched.paths, policy);
  if (Result.isFailure(checked)) {
    const [first, ...rest] = checked.failure.paths;
    return {
      _tag: "Refuse",
      reasons: [reason(first), ...rest.map(reason)],
      nextActions: checked.failure.nextActions,
    };
  }
  const plan = compile(
    undefined,
    { baseCommit: baseSha, touchedPaths: checked.success.touched, subjects: [], facts: {} },
    JS_TS_SUITE_PACK,
    defaultFlowPolicy,
  );
  // The pack is Keel's own and no project flow is read, so compile cannot refuse it.
  if (Result.isFailure(plan))
    throw new Error(
      `the js-ts pack does not compile: ${plan.failure.map((e) => e._tag).join(", ")}`,
    );
  const missing = plan.success.steps.map((s) => s.id).filter((id) => !L1_STEPS.has(id));
  const [gap, ...gaps] = missing;
  if (gap !== undefined)
    return {
      _tag: "Refuse",
      reasons: [`precheck:l1-plan-gap:${gap}`, ...gaps.map((id) => `precheck:l1-plan-gap:${id}`)],
      nextActions: [
        {
          kind: "call",
          title: missing.includes(HUMAN_CLASS_STEP)
            ? "Changes to .keel/flow and .keel/plugins need a ruling, which arrives at L2: split those edits out of this change, then submit again"
            : `Keel cannot run ${missing.join(", ")} until L2: split out what needs it, then submit again`,
          operationId: "submit",
          args: { steps: missing },
        },
      ],
    };
  return {
    _tag: "Compile",
    planHash: plan.success.planHash,
    steps: plan.success.steps.length,
    costEstimate: plan.success.costEstimate,
  };
};

/** Refuses the submission: a ruling-class bounce verdict, and ChangeBounced naming it. */
export const refuseSubmission = Effect.fn("verification/refuseSubmission")(function* (
  submission: PrecheckSubmission,
  decision: Extract<PrecheckDecision, { _tag: "Refuse" }>,
) {
  const verdictId: VerdictId = yield* (yield* ChangePrecheck).refused(submission.changeId, {
    ...call(submission),
    reasons: decision.reasons,
    nextActions: decision.nextActions,
  });
  return verdictId;
});

/** Records the compiled plan on the change: PlanCompiled. */
export const recordPlan = Effect.fn("verification/recordPlan")(function* (
  submission: PrecheckSubmission,
  decision: Extract<PrecheckDecision, { _tag: "Compile" }>,
) {
  yield* (yield* ChangePrecheck).compiled(submission.changeId, {
    ...call(submission),
    planHash: decision.planHash,
    steps: decision.steps,
    costEstimate: decision.costEstimate,
  });
});
