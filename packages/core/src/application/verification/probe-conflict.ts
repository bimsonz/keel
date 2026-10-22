import { Result } from "effect";
import type { Change, ChangeState } from "../../domain/coordination/index.ts";
import type { ChangeId, CommitSha, ContentHash } from "../../domain/kernel/index.ts";
import type {
  Conflict,
  DraftFailure,
  FlowWorld,
  Probe,
  SuspectEffect,
  SuspectPremise,
  World,
} from "../../domain/verification/index.ts";
import type { RepoRef } from "../ports/index.ts";
import type { DraftContext, DraftOutcome } from "./draft-probe.ts";
import type { GuardFile } from "./guard-file.ts";
import type { ProbeFile } from "./probe-templates/template.ts";
import type { MatrixCell } from "./run-matrix.ts";

/** How long the Probe Workflow waits, in all, for a party to submit: then DraftFailed `no-submission`. */
export const PROBE_SUBMISSION_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * How long the Probe Workflow waits, in all, for a proposal's commit to be
 * approved: a maintainer's pace, not its proposer's; then DraftFailed
 * `no-submission`. Once approved, a submission it still owes is waited for
 * PROBE_SUBMISSION_WAIT_MS from then.
 */
export const PROBE_APPROVAL_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The longest one wait of the Probe Workflow lasts: Workflows documents a
 * day as `waitForEvent`'s default timeout and no longer bound, so a longer
 * wait is several, the party read again between.
 */
export const PROBE_WAIT_SLICE_MS = 24 * 60 * 60 * 1000;

/** The two sides of a conflict a probe is drafted for: A holds the premise, B makes the effect against it. */
export interface ProbeParties {
  readonly A: ChangeId;
  readonly B: ChangeId;
  readonly premise: SuspectPremise;
  readonly effect: SuspectEffect;
}

/** A conflict's parties, or `no-propositions` when it names no premise or no effect: never guessed. */
export const partiesOf = (
  conflict: Pick<Conflict, "premise" | "effect">,
): Result.Result<ProbeParties, "no-propositions"> =>
  conflict.premise === undefined || conflict.effect === undefined
    ? Result.fail("no-propositions")
    : Result.succeed({
        A: conflict.premise.holder,
        B: conflict.effect.changeId,
        premise: conflict.premise,
        effect: conflict.effect,
      });

/** States in which a change has no current submission: it has not submitted, or a rebase awaits its next. */
const UNSUBMITTED: ReadonlySet<ChangeState> = new Set(["declared", "working", "bounced"]);
/** States a change has left the conflict from without landing. */
const GONE: ReadonlySet<ChangeState> = new Set(["withdrawn", "superseded"]);

/**
 * Where a party's world comes from: the commit it last submitted and that
 * submission's base, or, once it has landed, its commit on trunk.
 */
export type PartySubmission =
  | { readonly _tag: "Submitted"; readonly head: CommitSha; readonly base: CommitSha }
  | { readonly _tag: "Landed"; readonly landing: CommitSha }
  | { readonly _tag: "Unsubmitted" }
  /** A proposal whose commit waits for a maintainer's approval: no world until it is approved. */
  | { readonly _tag: "AwaitingApproval" }
  | { readonly _tag: "Gone"; readonly state: ChangeState };

/** The fields of a Change a party's world is read from: `landedCommit` is its commit on trunk, once it landed. */
export type PartyChange = Pick<Change, "state" | "commitSha" | "baseSha" | "landedCommit"> &
  Partial<Pick<Change, "proposal">>;

/**
 * A party's current submission, read from its Change: `commitSha` is the
 * commit it last submitted, and only a submission sets it. With none yet, or
 * in a state only a rebase leaves (which moves its base before it submits
 * again), the Probe waits for its next ChangeSubmitted; a change with no
 * `baseSha` (only one submitted before submissions carried it) waits too;
 * the wait's deadline ends it. A proposal waits until its commit is approved
 * (AwaitingApproval), on a maintainer's deadline rather than its proposer's. A workspace branch's moving head is never
 * read: a probe's evidence cites a fixed commit.
 *
 * The one rule for both sides of the wait: the Change DO's `awaitSubmission`
 * answers at once exactly when this is not Unsubmitted, and records the
 * subscriber otherwise, so no Probe waits on a subscription nobody holds.
 */
export const submissionStateOf = (change: PartyChange): PartySubmission => {
  if (GONE.has(change.state)) return { _tag: "Gone", state: change.state };
  // Landing collects the workspace, so a landed party's world is its commit on trunk.
  if (change.state === "landed")
    return change.landedCommit === undefined
      ? { _tag: "Gone", state: change.state }
      : { _tag: "Landed", landing: change.landedCommit };
  if (change.commitSha === undefined || change.baseSha === undefined)
    return { _tag: "Unsubmitted" };
  if (UNSUBMITTED.has(change.state)) return { _tag: "Unsubmitted" };
  // A proposal is no world until a maintainer approves the commit it carries: before that Keel drafts,
  // builds and runs nothing of it, and the Probe waits for the approval as for a submission.
  if (change.proposal !== undefined && change.proposal.approved !== change.commitSha)
    return { _tag: "AwaitingApproval" };
  return { _tag: "Submitted", head: change.commitSha, base: change.baseSha };
};

/** States in which a change's Precheck is still to answer: it has submitted, and no plan or refusal has come of it yet. */
const PRECHECKING: ReadonlySet<ChangeState> = new Set(["submitted", "deriving"]);

/**
 * The plan of a change's current submission, as its Change stands: compiled;
 * still to come; or none, in the state it is in.
 */
export type PlanState =
  | { readonly _tag: "Compiled"; readonly planHash: ContentHash }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "None"; readonly state: ChangeState };

/**
 * Whether a change's current submission has its plan, read from its Change.
 * While its Precheck runs the plan is Pending, whatever `planHash` holds: a
 * resubmitted change keeps its earlier submission's hash until the next
 * PlanCompiled, and that plan is not this submission's. Past Precheck, the
 * hash it holds is the plan it was verified under; with none (a Precheck that
 * refused, a change not yet submitted), no plan is coming.
 *
 * The one rule for both sides of a wait for the plan: the Change DO answers
 * at once exactly when this is not Pending, and records the subscriber
 * otherwise, so nothing waits on a subscription nobody holds.
 */
export const planStateOf = (change: Pick<Change, "state" | "planHash">): PlanState => {
  if (PRECHECKING.has(change.state)) return { _tag: "Pending" };
  return change.planHash === undefined
    ? { _tag: "None", state: change.state }
    : { _tag: "Compiled", planHash: change.planHash };
};

/** The code a draft is about: the anchors the premise and the effect name, premise first, each once. */
export const anchorsOf = (parties: ProbeParties): readonly string[] => [
  ...new Set(
    [
      ...(parties.premise.proposition.anchors ?? []),
      ...(parties.effect.proposition.anchors ?? []),
    ].map((a) => (a.symbol === undefined ? a.path : `${a.path} ${a.symbol}`)),
  ),
];

/** What a draft is drafted from, given the project's source at trunk and each change's hunks. */
export const draftContextOf = (
  parties: ProbeParties,
  source: DraftContext["source"],
  hunks: DraftContext["hunks"],
): DraftContext => ({
  premise: parties.premise.proposition,
  effect: parties.effect.proposition,
  anchors: anchorsOf(parties),
  source,
  hunks,
});

/** A party's side of the matrix: its submitted commit on its own base, or the commit it landed as and that commit's first parent. */
export type PartyWorld =
  | {
      readonly _tag: "Submitted";
      readonly repo: RepoRef;
      readonly head: CommitSha;
      readonly base: CommitSha;
    }
  | { readonly _tag: "Landed"; readonly landing: CommitSha; readonly parent: CommitSha };

export interface RepoCommit {
  readonly repo: RepoRef;
  readonly commit: CommitSha;
}

export interface RepoRange {
  readonly repo: RepoRef;
  readonly base: CommitSha;
  readonly head: CommitSha;
}

/** The commit each world is built from, and what the draft reads. */
export interface ProbeWorldPlan {
  /** Neither change in: trunk's head, or the landed side's first parent. */
  readonly trunk: RepoCommit;
  readonly A: RepoCommit;
  readonly B: RepoCommit;
  /** Both in: each side not yet landed composed onto `onto`, which is trunk's head or the landed side's commit. */
  readonly AB: { readonly onto: CommitSha; readonly members: readonly ("A" | "B")[] };
  /** Each change's hunks, from its base to its world's commit. */
  readonly hunks: { readonly A: RepoRange; readonly B: RepoRange };
  /** The project's source the draft reads: the trunk world's. */
  readonly source: RepoCommit;
}

/**
 * Where each world comes from. Neither side landed: trunk
 * is trunk's head and AB composes both onto it. One side landed as L: trunk
 * is L's first parent P, that side's world is L with hunks P..L, and AB
 * composes the other side onto L, so no later landing confounds it. A-noop
 * is always built from A's world. Both landed is too late to prove anything
 * before landing: `party-gone`.
 */
export const probeWorldPlan = (
  A: PartyWorld,
  B: PartyWorld,
  trunk: RepoCommit,
): Result.Result<ProbeWorldPlan, "party-gone"> => {
  if (A._tag === "Landed" && B._tag === "Landed") return Result.fail("party-gone");
  const side = (party: PartyWorld): { readonly world: RepoCommit; readonly hunks: RepoRange } =>
    party._tag === "Landed"
      ? {
          world: { repo: trunk.repo, commit: party.landing },
          hunks: { repo: trunk.repo, base: party.parent, head: party.landing },
        }
      : {
          world: { repo: party.repo, commit: party.head },
          hunks: { repo: party.repo, base: party.base, head: party.head },
        };
  const a = side(A);
  const b = side(B);
  const landed = A._tag === "Landed" ? A : B._tag === "Landed" ? B : undefined;
  const base: RepoCommit =
    landed === undefined ? trunk : { repo: trunk.repo, commit: landed.parent };
  return Result.succeed({
    trunk: base,
    A: a.world,
    B: b.world,
    AB:
      landed === undefined
        ? { onto: trunk.commit, members: ["A", "B"] }
        : { onto: landed.landing, members: A._tag === "Landed" ? ["B"] : ["A"] },
    hunks: { A: a.hunks, B: b.hunks },
    source: base,
  });
};

/** Each world's bundle as built. AB is absent when A and B do not compose. */
export interface BuiltWorlds {
  readonly trunk: ContentHash;
  readonly A: ContentHash;
  readonly B: ContentHash;
  readonly AB?: ContentHash | undefined;
}

/**
 * The four worlds a draft runs in besides A-noop. Without AB the conflict
 * cannot be probed: the matrix never runs short a world, and nothing stands
 * in for it.
 */
export const draftWorlds = (
  built: BuiltWorlds,
): Result.Result<Readonly<Record<FlowWorld, ContentHash>>, "worlds-unbuildable"> =>
  built.AB === undefined
    ? Result.fail("worlds-unbuildable")
    : Result.succeed({ trunk: built.trunk, A: built.A, B: built.B, AB: built.AB });

/** What the Probe Workflow reports to the conflict's ledger for a draft. */
export type ProbeReport =
  /** A probe that ran clean: ProbeDrafted, then every cell, and the domain admits or discards it. */
  | {
      readonly _tag: "Drafted";
      readonly attempts: number;
      readonly probe: ContentHash;
      readonly cells: readonly MatrixCell[];
      /** What its guard commits beside guard.json, should the domain admit it. */
      readonly files: readonly ProbeFile[];
    }
  /** No probe to calibrate: ProbeDiscarded as draft-failed, with why. */
  | {
      readonly _tag: "DraftFailed";
      readonly attempts: number;
      readonly reason: DraftFailure;
    };

/**
 * A draft's outcome as the ledger's facts. An admitted probe, or one that ran
 * clean and was found non-discriminating or unstable, is a real probe: it is
 * drafted with all its cells, and the domain decides it (a non-discriminating
 * probe dismisses its conflict). Anything else ended with no probe to run.
 */
export const reportsOf = (outcome: DraftOutcome): ProbeReport => {
  if (outcome._tag === "Admitted")
    return {
      _tag: "Drafted",
      attempts: outcome.attempts,
      probe: outcome.probe,
      cells: outcome.cells,
      files: outcome.files,
    };
  if (outcome._tag === "Abstained")
    return { _tag: "DraftFailed", attempts: outcome.attempts, reason: "abstained" };
  if (
    (outcome.reason === "non-discriminating" || outcome.reason === "unstable") &&
    outcome.ran !== undefined
  )
    return { _tag: "Drafted", attempts: outcome.attempts, ...outcome.ran };
  return {
    _tag: "DraftFailed",
    attempts: outcome.attempts,
    reason: outcome.reason === "repairs-exhausted" ? "repairs-exhausted" : "incomplete",
  };
};

/** The guard an admitted probe becomes, as the guard repo records it; none until the ledger admits it. */
export const guardOf = (probe: Probe | undefined, parties: ProbeParties): GuardFile | undefined =>
  probe?.state === "admitted" && probe.guardId !== undefined && probe.bundleHash !== undefined
    ? { guardId: probe.guardId, probe: probe.bundleHash, proposition: parties.premise.proposition }
    : undefined;

/** One party's suite in one world: the checks a conflict's world matrix records. */
export interface WorldCheckSpec {
  readonly world: World;
  /** `suite:trunk` or `suite:<changeId>`. */
  readonly check: string;
}

/** Trunk's suite on trunk, each party's own suite in its world, and both suites in AB. */
export const worldChecks = (parties: ProbeParties): readonly WorldCheckSpec[] => [
  { world: "trunk", check: "suite:trunk" },
  { world: "A", check: `suite:${parties.A}` },
  { world: "B", check: `suite:${parties.B}` },
  { world: "AB", check: `suite:${parties.A}` },
  { world: "AB", check: `suite:${parties.B}` },
];
