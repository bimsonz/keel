import { Effect, Result, Schema } from "effect";
import { PredicatePolicies, type SubjectKey } from "../../domain/coordination/index.ts";
import {
  type ChangeId,
  type CommitSha,
  ContentHash,
  NextAction,
  type NamespaceId,
  type ProjectId,
  type VerdictId,
} from "../../domain/kernel/index.ts";
import {
  type AdmittedGuard,
  compile,
  defaultFlowPolicy,
  GUARD_PATHS,
  HUMAN_CLASS_STEP,
  precheck,
  type PrecheckPolicy,
  type RefusedPath,
} from "../../domain/verification/index.ts";
import {
  AdmittedGuards,
  ChangePrecheck,
  CodeHost,
  FlowSpecSource,
  type FlowSources,
  type GuardRefused,
  PlanStore,
  type PrecheckWorkspace,
  Projects,
} from "../ports/index.ts";
import { FLOW_SPEC_PATH, flowSetup } from "./flow-spec.ts";
import { executable } from "./packs.ts";
import { readStoredPlan, storedPlanText } from "./plan-codec.ts";

/**
 * Precheck's use-cases, one per Workflow step: start, ancestry, diff, policy,
 * flow, guards, derive and derived (derive-submission.ts), decide, then refuse
 * or compile. Each is safe to replay: the Change DO's writes are idempotent by
 * instance, and the reads answer the same thing twice. What passes between
 * steps is plain data, small enough for a step's output.
 */

/**
 * The submission Precheck checks: `ChangeSubmitted`'s payload, and the
 * Workflow instance checking it. `baseSha` is the change's base when it was
 * submitted, the one it is judged against; it is absent only from events
 * committed before submissions carried it, and such a submission is refused.
 */
export interface PrecheckSubmission {
  readonly changeId: ChangeId;
  readonly revision: number;
  readonly commitSha: CommitSha;
  readonly baseSha: CommitSha | undefined;
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
    /** The compiled plan, as the plan store keeps it: put before PlanCompiled names its hash. */
    plan: Schema.String,
    /** The base's predicate policy, which the plan hash pins and the Change DO applies to a proven conflict. */
    predicatePolicy: PredicatePolicies,
    /** Why detection chose the verifier pack. */
    pack: Schema.String,
    /** Guards in the guard repo that could not be admitted to the plan, and why: shown, never skipped silently. */
    guardsRefused: Schema.Array(Schema.Struct({ guardId: Schema.String, reason: Schema.String })),
  }),
]);
export type PrecheckDecision = typeof PrecheckDecision.Type;

/**
 * Whether the submitted commit descends from the submission's base: it does
 * (so it is diffed against that base), it does not, it could not be read, or
 * the submission names no base.
 */
export type Ancestry =
  | { readonly _tag: "Descends"; readonly base: CommitSha }
  | { readonly _tag: "Diverged"; readonly base: CommitSha; readonly commit: CommitSha }
  | { readonly _tag: "Unreadable"; readonly reason: string }
  | { readonly _tag: "NoBase"; readonly commit: CommitSha };

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
 * Whether the submitted commit descends from the submission's base, through
 * any parent: after a rebase the base is a later trunk head, which the agent's
 * merge of keel/trunk brings in as a second parent. The walk stops at the
 * workspace's grant (`grantedSha`), which is trunk's own history from before
 * any base the change could have, and never reaches a later one. A submission
 * with no base is never judged against one Precheck guessed. A workspace or
 * commit the host cannot find is a refusal the agent can act on, never a defect.
 */
export const checkAncestry = Effect.fn("verification/checkAncestry")(function* (
  workspace: PrecheckWorkspace,
  submission: PrecheckSubmission,
) {
  const base = submission.baseSha;
  const commit = submission.commitSha;
  if (base === undefined) return { _tag: "NoBase", commit } satisfies Ancestry;
  const host = yield* CodeHost;
  return yield* host.isAncestor(workspace.repo, base, commit, [workspace.grantedSha]).pipe(
    Effect.map((descends): Ancestry =>
      descends ? { _tag: "Descends", base } : { _tag: "Diverged", base, commit },
    ),
    Effect.catchTags({
      RepoNotFound: (e) =>
        Effect.succeed<Ancestry>({
          _tag: "Unreadable",
          reason: `RepoNotFound ${e.repo.namespace}/${e.repo.name}`,
        }),
      ObjectNotFound: (e) =>
        Effect.succeed<Ancestry>({
          _tag: "Unreadable",
          reason:
            e.oid === commit
              ? `ObjectNotFound ${e.oid}`
              : `ObjectNotFound ${e.oid}, in the history of ${commit}`,
        }),
    }),
  );
});

/**
 * The paths the submitted commit changes against the submission's base, never
 * the grant's (which would count trunk's own changes since as the agent's) and
 * never trunk's head. A workspace or commit the host cannot find is a refusal
 * the agent can act on, not a failure to retry.
 */
export const diffSubmission = Effect.fn("verification/diffSubmission")(function* (
  workspace: PrecheckWorkspace,
  base: CommitSha,
  commitSha: CommitSha,
) {
  const host = yield* CodeHost;
  return yield* host.diffTrees(workspace.repo, base, commitSha).pipe(
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

/** The base commit's flow sources, or why they could not be read. */
export type FlowRead =
  | { readonly _tag: "Read"; readonly sources: FlowSources }
  | { readonly _tag: "Unreadable"; readonly reason: string };

/**
 * What decides the change's checks, read from the submission's base, never
 * its head: a change cannot edit its own checks. A workspace or commit the
 * host cannot find is a refusal the agent can act on, never a defect.
 */
export const readFlowSources = Effect.fn("verification/readFlowSources")(function* (
  workspace: PrecheckWorkspace,
  base: CommitSha,
) {
  return yield* (yield* FlowSpecSource).read(workspace.repo, base).pipe(
    Effect.map((sources): FlowRead => ({ _tag: "Read", sources })),
    Effect.catchTags({
      RepoNotFound: (e) =>
        Effect.succeed<FlowRead>({
          _tag: "Unreadable",
          reason: `RepoNotFound ${e.repo.namespace}/${e.repo.name}`,
        }),
      ObjectNotFound: (e) =>
        Effect.succeed<FlowRead>({ _tag: "Unreadable", reason: `ObjectNotFound ${e.oid}` }),
    }),
  );
});

/** The project's admitted guards, or why its guard repo could not be read. */
export type GuardsRead =
  | {
      readonly _tag: "Listed";
      readonly admitted: readonly AdmittedGuard[];
      readonly refused: readonly GuardRefused[];
    }
  | { readonly _tag: "Unreadable"; readonly reason: string };

/** Every guard the project has admitted, from the guard repo, for compile to select from. */
export const listGuards = Effect.fn("verification/listGuards")(function* (
  workspace: PrecheckWorkspace,
) {
  return yield* (yield* AdmittedGuards).list(workspace.projectId).pipe(
    Effect.map((list): GuardsRead => ({ _tag: "Listed", ...list })),
    Effect.catchTag("GuardsUnreadable", (e) =>
      Effect.succeed<GuardsRead>({ _tag: "Unreadable", reason: `guards: ${e.reason}` }),
    ),
  );
});

/**
 * The reads Precheck makes of a commit that descends from its base, one
 * durable step each, so which commit each reads is decided here and nowhere
 * else: the diff from the base to the commit, the project's policy, the
 * base's flow (never the head's) and the project's admitted guards.
 */
export const precheckReads = (
  workspace: PrecheckWorkspace,
  submission: PrecheckSubmission,
  ancestry: Extract<Ancestry, { readonly _tag: "Descends" }>,
) => ({
  touched: diffSubmission(workspace, ancestry.base, submission.commitSha),
  policy: precheckPolicy(workspace),
  flow: readFlowSources(workspace, ancestry.base),
  guards: listGuards(workspace),
});

/** A refused path as the verdict's evidence cites it: the rule, the path and the glob that caught it. */
const reason = (p: RefusedPath) => `precheck:${p.rule}:${p.path} (${p.glob})`;

/**
 * What Precheck's steps found: the ancestry, and, only for a commit that
 * descends from its base, the paths it touches, the project's policy, the
 * base's flow sources, the project's admitted guards and the plan's subjects
 * (`planSubjects`): those the change declared it touches or relies on, and
 * those Precheck derived an effect on.
 */
export type PrecheckFindings =
  | { readonly ancestry: Exclude<Ancestry, { readonly _tag: "Descends" }> }
  | {
      readonly ancestry: Extract<Ancestry, { readonly _tag: "Descends" }>;
      readonly touched: TouchedPaths;
      readonly policy: PrecheckPolicy;
      readonly flow: FlowRead;
      readonly guards: GuardsRead;
      readonly subjects: readonly SubjectKey[];
    };

const unreadable = (why: string): PrecheckDecision => ({
  _tag: "Refuse",
  reasons: [`precheck:unreadable:${why}`],
  nextActions: [
    {
      kind: "call",
      title:
        "Push the commit to the change's workspace again, on top of the change's base, then submit again",
      operationId: "submit",
    },
  ],
});

/** The refusal for a submission that is not judged on its paths: off its base, unreadable, or with no base. */
const ancestryRefusal = (
  ancestry: Exclude<Ancestry, { readonly _tag: "Descends" }>,
): PrecheckDecision => {
  if (ancestry._tag === "Unreadable") return unreadable(ancestry.reason);
  if (ancestry._tag === "NoBase")
    return {
      _tag: "Refuse",
      reasons: [
        `precheck:no-base:${ancestry.commit} was submitted without the base it is judged against`,
      ],
      nextActions: [
        {
          kind: "call",
          title:
            "Submit the commit again: a submission now carries the change's base, and Keel never judges a change against a base it guessed",
          operationId: "submit",
        },
      ],
    };
  return {
    _tag: "Refuse",
    reasons: [`precheck:not-on-base:${ancestry.commit} does not descend from ${ancestry.base}`],
    nextActions: [
      {
        kind: "call",
        title: `Rebase the change (Keel puts trunk's head on your workspace's keel/trunk branch), then run git fetch origin keel/trunk && git merge FETCH_HEAD, push, and submit again: the submitted commit does not descend from the change's base ${ancestry.base}`,
        operationId: "rebase",
        args: { base: ancestry.base },
      },
    ],
  };
};

/** A base whose flow cannot be compiled: the change cannot fix it, since checks come from the base. */
const brokenFlow = (why: string): PrecheckDecision => ({
  _tag: "Refuse",
  reasons: [`precheck:flow-invalid:${why}`],
  nextActions: [
    {
      kind: "escalate",
      title: `Ask an operator to repair ${FLOW_SPEC_PATH} on trunk: Keel reads a change's checks from its base, and the base's flow does not compile`,
      args: { path: FLOW_SPEC_PATH },
    },
  ],
});

/**
 * The decision, a pure function of the steps' outputs. A commit that does
 * not descend from its base, could not be read, or names no base is refused
 * before its paths are read. Otherwise refuse guard and protected paths, and
 * a submission the diff, the flow or the guard repo could not read. Then
 * compile the plan from the base: the project's flow (or its detected pack's)
 * and its predicate policy, with the admitted guards the change is exposed
 * to. A plan holding a step KeelVerify cannot run yet (today a human-class
 * gate, which a flow change adds) is refused rather than let through
 * without it, or parked by design.
 */
export const decidePrecheck = (findings: PrecheckFindings): PrecheckDecision => {
  if (!("touched" in findings)) return ancestryRefusal(findings.ancestry);
  const { ancestry, touched, policy, flow, guards, subjects } = findings;
  const baseSha = ancestry.base;
  if (touched._tag === "Unreadable") return unreadable(touched.reason);
  const checked = precheck(touched.paths, policy);
  if (Result.isFailure(checked)) {
    const [first, ...rest] = checked.failure.paths;
    return {
      _tag: "Refuse",
      reasons: [reason(first), ...rest.map(reason)],
      nextActions: checked.failure.nextActions,
    };
  }
  if (flow._tag === "Unreadable") return unreadable(flow.reason);
  if (guards._tag === "Unreadable") return unreadable(guards.reason);
  const setup = flowSetup(flow.sources, baseSha);
  if (Result.isFailure(setup)) return brokenFlow(setup.failure.reason);
  const { definition, predicatePolicy, pack } = setup.success;
  const plan = compile(
    definition,
    {
      baseCommit: baseSha,
      touchedPaths: checked.success.touched,
      subjects,
      facts: {},
      predicatePolicy,
      admittedGuards: guards.admitted,
    },
    pack.defaults,
    defaultFlowPolicy,
  );
  if (Result.isFailure(plan)) return brokenFlow(plan.failure.map((e) => e._tag).join(", "));
  const missing = plan.success.steps.filter((s) => !executable(s)).map((s) => s.id);
  const [gap, ...gaps] = missing;
  if (gap !== undefined)
    return {
      _tag: "Refuse",
      reasons: [`precheck:plan-gap:${gap}`, ...gaps.map((id) => `precheck:plan-gap:${id}`)],
      nextActions: [
        {
          kind: "call",
          title: missing.includes(HUMAN_CLASS_STEP)
            ? "Changes to .keel/flow and .keel/plugins need a ruling, which a running plan cannot take yet: split those edits out of this change, then submit again"
            : `Keel cannot run ${missing.join(", ")} yet: split out what needs it, then submit again`,
          operationId: "submit",
          args: { steps: missing },
        },
      ],
    };
  const text = storedPlanText(plan.success);
  // compile stamps the hash it computed, so the plan's own hash cannot lie.
  if (Result.isFailure(text)) throw new Error(text.failure);
  return {
    _tag: "Compile",
    planHash: plan.success.planHash,
    steps: plan.success.steps.length,
    costEstimate: plan.success.costEstimate,
    plan: text.success,
    predicatePolicy,
    pack: pack.reason,
    guardsRefused: guards.refused,
  };
};

/**
 * The refusal for a submission to a project with no place. It belongs to no
 * namespace, so there is nowhere to keep its derivation, its plan or its
 * evidence, and there is no namespace to fall back on. A project is placed
 * when it is created and never after, so the next action is a person's.
 */
export const refuseUnplaced = (
  projectId: ProjectId,
): Extract<PrecheckDecision, { _tag: "Refuse" }> => ({
  _tag: "Refuse",
  reasons: [
    `precheck:project-unplaced:project ${projectId} belongs to no namespace, so nothing of this change can be kept or verified`,
  ],
  nextActions: [
    {
      kind: "escalate",
      title:
        "Ask the project's owner to create a project in a namespace and submit this change there: this project has no place in one",
      args: { projectId },
    },
  ],
});

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

/**
 * Stores the compiled plan, then records it on the change: PlanCompiled. The
 * plan is stored first, so a hash the lane queues always resolves; storing is
 * content-addressed, so a replay stores the same plan again.
 */
export const recordPlan = Effect.fn("verification/recordPlan")(function* (
  namespace: NamespaceId,
  submission: PrecheckSubmission,
  decision: Extract<PrecheckDecision, { _tag: "Compile" }>,
) {
  const plan = readStoredPlan(decision.planHash, decision.plan);
  if (Result.isFailure(plan)) return yield* Effect.die(new Error(plan.failure));
  yield* (yield* PlanStore).put(namespace, plan.success);
  return yield* (yield* ChangePrecheck).compiled(submission.changeId, {
    ...call(submission),
    planHash: decision.planHash,
    steps: decision.steps,
    costEstimate: decision.costEstimate,
    predicatePolicy: decision.predicatePolicy,
  });
});
