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
 * Precheck's use-cases, one per Workflow step: start, ancestry, diff, policy,
 * then refuse or compile. Each is safe to replay: the Change DO's writes are
 * idempotent by instance, and the reads answer the same thing twice. What
 * passes between steps is plain data, small enough for a step's output.
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

const L1_STEPS = new Set(L1_SUITE_PLAN.steps.map((s) => s.id));

/** A refused path as the verdict's evidence cites it: the rule, the path and the glob that caught it. */
const reason = (p: RefusedPath) => `precheck:${p.rule}:${p.path} (${p.glob})`;

/**
 * What Precheck's steps found: the ancestry, and, only for a commit that
 * descends from its base, the paths it touches and the project's policy.
 */
export type PrecheckFindings =
  | { readonly ancestry: Exclude<Ancestry, { readonly _tag: "Descends" }> }
  | {
      readonly ancestry: Extract<Ancestry, { readonly _tag: "Descends" }>;
      readonly touched: TouchedPaths;
      readonly policy: PrecheckPolicy;
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

/**
 * The decision, a pure function of the steps' outputs. A commit that does
 * not descend from its base, could not be read, or names no base is refused
 * before its paths are read. Otherwise refuse guard and protected paths, and
 * a submission the diff could not read, and compile the plan from the base.
 * Until D2.1 runs compiled plans, KeelVerify runs only L1's static plan, so a
 * plan needing any other step (today the human-class gate a flow change adds)
 * is refused rather than let through without it.
 */
export const decidePrecheck = (findings: PrecheckFindings): PrecheckDecision => {
  if (!("touched" in findings)) return ancestryRefusal(findings.ancestry);
  const { ancestry, touched, policy } = findings;
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
