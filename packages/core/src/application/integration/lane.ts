import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import {
  ChangeBounced,
  ChangeParked,
  ChangeQueued,
  ChangeRequeued,
  ChangeResumed,
  ChangeSuperseded,
  ChangeWithdrawn,
  ProposalApproved,
  ProposalUpdated,
} from "../../domain/coordination/index.ts";
import {
  attribute,
  Batch,
  type BatchAttribution,
  batchSize,
  CandidateEvent,
  type CandidateCommand,
  CandidateNotFound,
  type CandidateRejection,
  changeIdOf,
  type CompositionRefused,
  decideCandidate,
  evolveCandidate,
  isCandidateTerminal,
  planBatches,
  PromotionDeclined,
  type QueuedChange,
  ResultFenced,
  runsAlone,
  TrunkAdvanced,
  TrunkSynced,
  VerificationStarted,
} from "../../domain/integration/index.ts";
import {
  actorParts,
  BatchId,
  CandidateId,
  ChangeId,
  type CommandActor,
  CommitSha,
  ContentHash,
  type Counterpart,
  type EntityRef,
  type EventEnvelope,
  globsMayOverlap,
  type Instant,
  InstantSchema,
  type NamespaceId,
  namespaceKind,
  NextAction,
  ProjectId,
  VerdictId,
} from "../../domain/kernel/index.ts";
import {
  type FlowPlan,
  StepCount,
  unionPlans,
  VerdictOutcome,
  VerdictIssued,
} from "../../domain/verification/index.ts";
import {
  askShrinkRuling,
  decisionIdOf,
  shrinkLine,
  type ShrunkStep,
  shrinkRulingIdOf,
} from "../coordination/index.ts";
import {
  AgentDirectory,
  type BatchStepReport,
  type BatchVerdict,
  BatchVerification,
  CandidateBundles,
  CandidateComposer,
  type CandidateMember,
  Changes,
  Clock,
  CodeHost,
  commit,
  EntityStore,
  type EventDraft,
  EventOutbox,
  Ids,
  Lanes,
  Namespaces,
  PlanStore,
  Projects,
  REDELIVERY_CAP_MS,
  type RepoRef,
  StagingWriter,
  type Transaction,
  type Transition,
} from "../ports/index.ts";
import { haltedActions, projectNamespace } from "../verification/index.ts";
import { projectRepos } from "./project-repos.ts";

/** The EntityStore kinds the Lane keeps: its queue and batch in flight, and each batch as its events fold. */
const LANE = "lane";
const BATCH = "batch";
/** The EntityStore kind marking a lane destroyed, keyed by its id. */
const DESTROYED = "lane-destroyed";
const MAIN = "refs/heads/main";

/** What a member change hears of its own batches: the Form commit subscribes it, scoped to `change:<id>`. */
const MEMBER_EVENTS = [
  "BatchFormed",
  "BatchFailed",
  "CandidateBisected",
  "CandidateInvalidated",
  "VerdictIssued",
];

/**
 * On this many consecutive infra failures of one change the Lane bounces it,
 * so it never loops: at once when another batch of the lane has verified since
 * they began (the infrastructure works for others), else once INFRA_HOLD_MS
 * has passed since the first.
 */
export const INFRA_FAILURE_LIMIT = 3;

/**
 * How long a change at INFRA_FAILURE_LIMIT is held for an outage that is
 * Keel's, not the change's: while no other batch has verified since its infra
 * failures began, it goes back to the queue's front until this long after the
 * first, and only then bounces.
 */
export const INFRA_HOLD_MS = 2 * 60 * 60 * 1000;

/**
 * A batch whose compose, bundle or start has failed this many times (each a
 * step that threw, or whose invocation died) is not tried again: the next
 * step fails it on the infrastructure where it stands, which requeues its
 * change and counts towards `INFRA_FAILURE_LIMIT`.
 */
export const STEP_FAILURES_BEFORE_INFRA = 3;

/** How much of a thrown step's error a batch keeps with its attempt. */
const STEP_ERROR_MAX = 300;

/** A green batch trunk has not answered is first re-offered this long after its BatchVerified. */
export const REOFFER_AFTER_MS = 30_000;

/** The wait before the re-offer after `count` of them: 30 s, doubling, capped as redeliveries are (60 s). */
export const reofferDelay = (count: number): number =>
  Math.min(REOFFER_AFTER_MS * 2 ** count, REDELIVERY_CAP_MS);

/** The batch in flight and what the Lane learned composing and bundling it. */
const ActiveBatch = Schema.Struct({
  batchId: BatchId,
  /** Minted with the batch, so a retried compose pushes the same candidate ref. */
  candidateId: CandidateId,
  /**
   * The plan KeelVerify runs: the member's, as its ChangeQueued or
   * ChangeRequeued named it. A batch formed with none is refused at
   * composition, so no candidate is ever verified under another plan.
   */
  planHash: Schema.optional(ContentHash),
  /** The candidate's tip in staging and each member's restacked commit, in batch order. */
  composed: Schema.optional(
    Schema.Struct({
      commitSha: CommitSha,
      commits: Schema.Array(Schema.Struct({ changeId: ChangeId, sha: CommitSha })),
    }),
  ),
  bundle: Schema.optional(ContentHash),
  /** KeelVerify's instance exists: the start is retried until it does. */
  started: Schema.optional(Schema.Boolean),
  /** Trunk declined to promote the green batch: it is invalidated, and its members go back to the queue. */
  declined: Schema.optional(Schema.Boolean),
  /**
   * The compose, bundle or start a step is attempting, marked before it runs:
   * a step that finds its own stage still marked knows that attempt failed,
   * whether it threw (`error`, as the Lane DO recorded it) or the invocation
   * running it died.
   */
  attempt: Schema.optional(
    Schema.Struct({
      stage: Schema.Literals(["compose", "bundle", "start"]),
      error: Schema.optional(Schema.String),
    }),
  ),
  /** Why each attempt at the batch's compose, bundle or start that did not get through failed, oldest first. */
  failed: Schema.optional(Schema.Array(Schema.String)),
  /** The green batch's BatchVerified re-offered to trunk so far, and when the last went (epoch ms). */
  reoffered: Schema.optional(Schema.Struct({ count: Schema.Int, at: Schema.Number })),
  /** Behind the batch in flight: the batch whose candidate this one was composed on. */
  on: Schema.optional(BatchId),
  /** Behind the batch in flight: KeelVerify's verdict, kept until every batch ahead has landed. */
  kept: Schema.optional(
    Schema.Struct({
      instanceId: Schema.String,
      fence: Schema.Struct({ batchId: BatchId, attempt: Schema.Int, chainEpoch: Schema.Int }),
      candidateId: CandidateId,
      verdictId: VerdictId,
      outcome: VerdictOutcome,
      planHash: ContentHash,
      evidence: Schema.Array(Schema.String),
      failingTests: Schema.Array(Schema.String),
      nextActions: Schema.optionalKey(Schema.Array(NextAction)),
      unrun: Schema.optionalKey(Schema.Literal(true)),
      retryAt: Schema.optionalKey(InstantSchema),
      halted: Schema.optionalKey(Schema.Literal(true)),
      tests: Schema.optionalKey(Schema.Array(StepCount)),
    }),
  ),
  /** Its land issued: the tests its verdict counted, trunk's last verdict's once trunk takes the batch. */
  landing: Schema.optional(Schema.Array(StepCount)),
});
type ActiveBatch = typeof ActiveBatch.Type;

/**
 * A drop in tests a maintainer was asked about (the shrink rule), one per
 * change: the verdict that counted it, and per step how many fewer tests
 * passed than trunk's last verdict did. `accepted` once the ruling's approve
 * resumed the change: a batch holding it may then pass that many fewer,
 * until it lands, ends or is submitted again.
 */
const AskedDrop = Schema.Struct({
  changeId: ChangeId,
  verdictId: VerdictId,
  steps: Schema.Array(Schema.Struct({ stepId: Schema.NonEmptyString, fewer: Schema.Int })),
  accepted: Schema.optional(Schema.Literal(true)),
});

/** A lane: its FIFO queue, its one batch in flight, trunk advances staging has yet to follow. */
export const Lane = Schema.Struct({
  laneId: Schema.String,
  projectId: ProjectId,
  queue: Schema.Array(ChangeId),
  /** Each queued change's compiled plan, from the ChangeQueued or ChangeRequeued that queued it. */
  plans: Schema.optional(
    Schema.Array(Schema.Struct({ changeId: ChangeId, planHash: ContentHash })),
  ),
  active: Schema.optional(ActiveBatch),
  /**
   * Speculation: batches formed on the candidate of the batch ahead (the
   * first on the batch in flight's), each verified at once. A verdict for one
   * is kept until every batch ahead has landed, so trunk is only ever offered
   * the batch in flight; any failure of one, or of a batch ahead, cancels it
   * and every batch behind it.
   */
  behind: Schema.optional(Schema.Array(ActiveBatch)),
  /** Bumped by every cancel, so a verdict for a cancelled batch is fenced. */
  chainEpoch: Schema.optional(Schema.Int),
  /**
   * The batch in flight a batch behind it failed behind (refused, or its step
   * failed): nothing more forms behind it, so the changes that failed there
   * wait to form in flight, where a refusal is decided as any other.
   */
  heldBehind: Schema.optional(BatchId),
  /**
   * Each change's place in the lane: the order it first joined the queue in.
   * A change requeued goes back to its place, never to the front, so one that
   * keeps failing never overtakes changes that were waiting before it.
   */
  places: Schema.optional(Schema.Array(Schema.Struct({ changeId: ChangeId, place: Schema.Int }))),
  /** How many changes have joined the queue: the next to join takes the place after them. */
  joined: Schema.optional(Schema.Int),
  advances: Schema.Array(
    Schema.Struct({ from: CommitSha, to: CommitSha, members: Schema.Array(ChangeId) }),
  ),
  /**
   * Each change's consecutive infra failures, their reasons oldest first, with
   * when the first came (epoch ms) and how many batches the lane had verified then.
   */
  infra: Schema.Array(
    Schema.Struct({
      changeId: ChangeId,
      reasons: Schema.Array(Schema.String),
      since: Schema.optional(Schema.Number),
      verifiedBefore: Schema.optional(Schema.Int),
    }),
  ),
  /** Trunk's head as the last TrunkAdvanced heard named it: no batch forms on a staging main anywhere else. */
  trunkHead: Schema.optional(CommitSha),
  /**
   * When the project's namespace has container-minutes again (epoch ms): a
   * verification parked unrun for want of them said so, and no batch forms,
   * in flight or behind, before then.
   */
  notBefore: Schema.optional(Schema.Number),
  /**
   * When the namespace's box gate said its soonest lease ends (epoch ms),
   * after it had no room for a composition: no batch forms before then,
   * unless the gate says a box was freed first (`boxFreed`).
   */
  boxWait: Schema.optional(Schema.Number),
  /** The last candidate bundle this lane stored: the next takes from it what did not change. */
  lastBundle: Schema.optional(ContentHash),
  /** The outcome of each member verified lately, oldest first, at most OUTCOME_WINDOW: the batch size is read from it. */
  outcomes: Schema.optional(Schema.Array(Schema.Literals(["pass", "fail"]))),
  /** How many batches the lane has verified, landed or bounced on a member: an infra streak reads whether any did since it began. */
  verified: Schema.optional(Schema.Int),
  /**
   * The changes that run alone in their next batch: each requeued after its
   * members clashed (`runsAlone`), spent on the infrastructure in a batch of
   * several, or split out of a failed batch by its bisection, which named the
   * batch it forms under.
   */
  alone: Schema.optional(
    Schema.Array(Schema.Struct({ changeId: ChangeId, batchId: Schema.optional(BatchId) })),
  ),
  /**
   * Trunk's last verdict, as the project's shrink rule reads it: per step the
   * rule watches, the tests the last batch trunk took that ran it passed.
   */
  tests: Schema.optional(Schema.Array(StepCount)),
  /** The drops in tests put to a maintainer, asked or accepted, by change. */
  drops: Schema.optional(Schema.Array(AskedDrop)),
});
export type Lane = typeof Lane.Type;

const decodeLane = Schema.decodeUnknownSync(Schema.toCodecJson(Lane));
const encodeLane = Schema.encodeSync(Schema.toCodecJson(Lane));
const decodeBatch = Schema.decodeUnknownSync(Schema.toCodecJson(Batch));
const encodeBatch = Schema.encodeSync(Schema.toCodecJson(Batch));
const encodeCandidateEvent = Schema.encodeSync(Schema.toCodecJson(CandidateEvent));
const encodeVerdict = Schema.encodeSync(Schema.toCodecJson(VerdictIssued));
const decodeProject = Schema.decodeUnknownSync(ProjectId);

type Store = (typeof EntityStore)["Service"];

/** A lane is addressed `lane:<projectId>:<name>`; a project's one lane is `lane:<projectId>:main`. */
export const laneProject = (laneId: string): ProjectId => {
  const match = /^lane:([^:]+):[^:]+$/.exec(laneId);
  if (match?.[1] === undefined)
    throw new Error(`a lane is addressed lane:<projectId>:<name>, not ${laneId}`);
  return decodeProject(match[1]);
};

export const laneOf = (store: Store, laneId: string): Lane | undefined => {
  const stored = store.get(LANE, laneId);
  return stored === undefined ? undefined : decodeLane(stored);
};

const putLane = (store: Store, lane: Lane): void => store.put(LANE, lane.laneId, encodeLane(lane));

const emptyLane = (laneId: string): Lane => ({
  laneId,
  projectId: laneProject(laneId),
  queue: [],
  advances: [],
  infra: [],
});

/**
 * How many changes the lane holds, as a reader is shown it: those queued, and
 * the members of the batch in flight, which left the queue when it formed. A
 * lane no change ever joined holds none.
 */
export const laneStanding = Effect.fn("integration/laneStanding")(function* (laneId: string) {
  const store = yield* EntityStore;
  const lane = laneOf(store, laneId);
  const inFlight = [lane?.active, ...(lane?.behind ?? [])].reduce(
    (sum, slot) =>
      sum + (slot === undefined ? 0 : (batchOf(store, slot.batchId)?.members.length ?? 0)),
    0,
  );
  return { queued: lane?.queue.length ?? 0, inFlight };
});

/** Whether the lane was destroyed: it then hears no event, forms no batch and takes no verdict. */
export const laneDestroyed = (store: Store, laneId: string): boolean =>
  store.get(DESTROYED, laneId) !== undefined;

/** The plan a queued change was queued with, if its event named one. */
const planOf = (lane: Lane, changeId: ChangeId): ContentHash | undefined =>
  lane.plans?.find((p) => p.changeId === changeId)?.planHash;

/** The lane with `changeId`'s plan replaced by `planHash` (none: forgotten). */
const withPlan = (lane: Lane, changeId: ChangeId, planHash: ContentHash | undefined): Lane => ({
  ...lane,
  plans: [
    ...(lane.plans ?? []).filter((p) => p.changeId !== changeId),
    ...(planHash === undefined ? [] : [{ changeId, planHash }]),
  ],
});

/** Whether `changeId` runs alone in its next batch, and under which batch id when a bisection named one. */
const aloneOf = (lane: Lane, changeId: ChangeId) =>
  lane.alone?.find((entry) => entry.changeId === changeId);

/** The lane with `changeIds` to run alone next (kept as they are when already so). */
const withAlone = (lane: Lane, changeIds: readonly ChangeId[]): Lane => {
  const added = changeIds.filter((id) => aloneOf(lane, id) === undefined);
  return added.length === 0
    ? lane
    : { ...lane, alone: [...(lane.alone ?? []), ...added.map((changeId) => ({ changeId }))] };
};

/** The lane with `changeIds` no longer marked to run alone. */
const withoutAlone = (lane: Lane, changeIds: readonly ChangeId[]): Lane =>
  lane.alone === undefined
    ? lane
    : { ...lane, alone: lane.alone.filter((entry) => !changeIds.includes(entry.changeId)) };

/** The lane with the drops in tests of `changeIds` forgotten: each landed, ended or was submitted again. */
const withoutDrops = (lane: Lane, changeIds: readonly ChangeId[]): Lane =>
  lane.drops === undefined || !lane.drops.some((d) => changeIds.includes(d.changeId))
    ? lane
    : { ...lane, drops: lane.drops.filter((d) => !changeIds.includes(d.changeId)) };

/** The lane with trunk's last verdict taking `landed`'s count for each step it counted. */
const withTrunkTests = (lane: Lane, landed: readonly StepCount[]): Lane => ({
  ...lane,
  tests: [
    ...(lane.tests ?? []).filter((t) => !landed.some((l) => l.stepId === t.stepId)),
    ...landed,
  ],
});

/** A step whose candidate passed fewer tests than trunk's last verdict allows, and what it allows. */
interface Shrunk extends ShrunkStep {
  readonly allowed: number;
}

/**
 * The project's shrink rule over a verdict's counts (only the steps it
 * watches are counted): each step whose candidate passed fewer tests than
 * trunk's last verdict did, less the drop a maintainer accepted for any of
 * the batch's members. A step trunk has no count for yet is held to nothing.
 */
export const shrunkSteps = (
  lane: Lane,
  members: readonly ChangeId[],
  counted: readonly StepCount[],
): readonly Shrunk[] =>
  counted.flatMap((count) => {
    const trunk = lane.tests?.find((t) => t.stepId === count.stepId);
    if (trunk === undefined) return [];
    const accepted = (lane.drops ?? [])
      .filter((d) => d.accepted === true && members.includes(d.changeId))
      .reduce((sum, d) => sum + (d.steps.find((s) => s.stepId === count.stepId)?.fewer ?? 0), 0);
    const allowed = trunk.passed - accepted;
    return count.passed < allowed
      ? [{ stepId: count.stepId, passed: count.passed, trunk: trunk.passed, allowed }]
      : [];
  });

/** How many of its members' latest outcomes a lane reads its failure rate from. */
export const OUTCOME_WINDOW = 20;

/**
 * The lane's recent failure rate: failures among its last OUTCOME_WINDOW
 * member outcomes, an outcome not yet seen counting as a pass, so a new lane
 * starts at the project's largest batch.
 */
export const failureRate = (lane: Lane): number =>
  (lane.outcomes ?? []).filter((outcome) => outcome === "fail").length / OUTCOME_WINDOW;

/**
 * The largest batch the lane forms next: the size that lands the most of its
 * queue per verification at its recent failure rate (`batchSize`), within the
 * project's `maxBatchSize`.
 */
export const laneBatchSize = (lane: Lane, maxBatchSize: number): number =>
  batchSize(failureRate(lane), Math.min(maxBatchSize, lane.queue.length));

/** The lane with a verified batch's `added` outcomes after its last, keeping the latest OUTCOME_WINDOW. */
const withOutcomes = (lane: Lane, added: readonly ("pass" | "fail")[]): Lane =>
  added.length === 0
    ? lane
    : {
        ...lane,
        outcomes: [...(lane.outcomes ?? []), ...added].slice(-OUTCOME_WINDOW),
        verified: (lane.verified ?? 0) + 1,
      };

/** The batch as its events left it. */
export const batchOf = (store: Store, batchId: BatchId): Batch | undefined => {
  const stored = store.get(BATCH, batchId);
  return stored === undefined ? undefined : decodeBatch(stored);
};

const batchRef = (batchId: BatchId): EntityRef => ({ kind: "batch", id: batchId });
const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });

const isTagged = (json: Schema.Json): json is EventDraft["payload"] =>
  typeof json === "object" &&
  json !== null &&
  !Array.isArray(json) &&
  "_tag" in json &&
  typeof json["_tag"] === "string";

const payloadOf = (json: Schema.Json, tag: string): EventDraft["payload"] => {
  if (!isTagged(json)) throw new Error(`${tag} did not encode as a tagged object`);
  return json;
};

/** A batch event, naming its members as affected so each member's scoped subscription hears it. */
const batchDraft = (event: CandidateEvent, members: readonly ChangeId[]): EventDraft => ({
  payload: payloadOf(encodeCandidateEvent(event), event._tag),
  affected: members.map(changeRef),
});

/** A verdict on the batch, on the verdict's own entity, naming the members as affected. */
const verdictDraft = (
  verdict: typeof VerdictIssued.Type,
  members: readonly ChangeId[],
): EventDraft => ({
  entity: { kind: "verdict", id: verdict.verdictId },
  payload: payloadOf(encodeVerdict(verdict), verdict._tag),
  affected: members.map(changeRef),
});

const fold = (batch: Batch | undefined, events: readonly CandidateEvent[], at: Instant): Batch => {
  const folded = events.reduce<Batch | undefined>(
    (state, payload) => evolveCandidate(state, { at, payload }),
    batch,
  );
  if (folded === undefined) throw new Error("a batch decision folded to no batch");
  return folded;
};

/** Whether the lane already holds a change: queued, or a member of its batch in flight. */
const holds = (store: Store, lane: Lane, changeId: ChangeId): boolean =>
  lane.queue.includes(changeId) ||
  [lane.active, ...(lane.behind ?? [])].some(
    (slot) =>
      slot !== undefined && (batchOf(store, slot.batchId)?.members.includes(changeId) ?? false),
  );

/** The order `changeId` first joined the lane's queue in; 0 for one queued before places were kept. */
const placeOf = (lane: Lane, changeId: ChangeId): number | undefined =>
  lane.places?.find((entry) => entry.changeId === changeId)?.place;

/**
 * The lane with `changeId` in its queue at its place: after every change that
 * first joined before it. A change the lane never placed takes the next place,
 * so it joins at the back; one queued before places were kept counts as first.
 */
const enqueue = (lane: Lane, changeId: ChangeId): Lane => {
  const known = placeOf(lane, changeId);
  const joined = (lane.joined ?? 0) + (known === undefined ? 1 : 0);
  const place = known ?? joined;
  const placed: Lane =
    known === undefined
      ? { ...lane, joined, places: [...(lane.places ?? []), { changeId, place }] }
      : lane;
  const at = placed.queue.findIndex((id) => (placeOf(placed, id) ?? 0) > place);
  return {
    ...placed,
    queue:
      at === -1
        ? [...placed.queue, changeId]
        : [...placed.queue.slice(0, at), changeId, ...placed.queue.slice(at)],
  };
};

/** The lane with the places of `changeIds` forgotten: each has left the lane for good. */
const unplace = (lane: Lane, changeIds: readonly ChangeId[]): Lane =>
  lane.places === undefined
    ? lane
    : { ...lane, places: lane.places.filter((entry) => !changeIds.includes(entry.changeId)) };

/** The lane with `batchId`'s batch, in flight or behind it, replaced by `update` of it. */
const withSlot = (
  lane: Lane,
  batchId: BatchId,
  update: (slot: ActiveBatch) => ActiveBatch,
): Lane =>
  lane.active?.batchId === batchId
    ? { ...lane, active: update(lane.active) }
    : {
        ...lane,
        behind: (lane.behind ?? []).map((slot) => (slot.batchId === batchId ? update(slot) : slot)),
      };

/** Whether `batchId` is one of the batches behind the batch in flight. */
const isBehind = (lane: Lane, batchId: BatchId): boolean =>
  (lane.behind ?? []).some((slot) => slot.batchId === batchId);

const decodeQueued = Schema.decodeUnknownSync(ChangeQueued);
const decodeRequeued = Schema.decodeUnknownSync(ChangeRequeued);
const decodeParked = Schema.decodeUnknownSync(ChangeParked);
const decodeResumed = Schema.decodeUnknownSync(ChangeResumed);
const decodeApproved = Schema.decodeUnknownSync(ProposalApproved);
const decodeAdvanced = Schema.decodeUnknownSync(TrunkAdvanced);
const decodeSynced = Schema.decodeUnknownSync(TrunkSynced);
const decodeDeclined = Schema.decodeUnknownSync(PromotionDeclined);
const decodeStarted = Schema.decodeUnknownSync(VerificationStarted);
const decodeEnded = Schema.decodeUnknownSync(
  Schema.Union([ChangeWithdrawn, ChangeSuperseded, ChangeBounced, ProposalUpdated]),
);

/**
 * A delivered event, inside the transaction that records it: ChangeQueued
 * joins the queue's back, ChangeRequeued its front (it re-enters with no
 * blame), each keeping the plan hash its event names, a change parked for a
 * person's ruling while queued leaves the queue with its plan kept and
 * rejoins at the front when it is resumed, as a proposal parked for approval
 * does when it is approved, a change withdrawn, superseded or bounced while
 * queued, or a proposal moved to another commit, leaves the queue (one in
 * the batch in flight finishes its batch),
 * TrunkAdvanced is noted for staging to follow and names trunk's head (as is
 * TrunkSynced, an advance no change made), and a
 * PromotionDeclined of the batch in flight marks it to be invalidated. State
 * only: the step commits the events. A destroyed lane hears nothing. True
 * when the lane changed.
 */
export const laneHeard = (tx: Transaction, laneId: string, event: EventEnvelope): boolean => {
  if (laneDestroyed(tx.store, laneId)) return false;
  const lane = laneOf(tx.store, laneId) ?? emptyLane(laneId);
  const next = ((): Lane | undefined => {
    switch (event.type) {
      case "ChangeQueued": {
        const queued = decodeQueued(event.payload);
        // A submission is judged afresh: no drop in tests asked about an earlier one stands for it.
        return queued.laneId !== laneId || holds(tx.store, lane, queued.changeId)
          ? undefined
          : withoutDrops(
              withPlan(enqueue(lane, queued.changeId), queued.changeId, queued.planHash),
              [queued.changeId],
            );
      }
      case "ChangeRequeued": {
        const requeued = decodeRequeued(event.payload);
        if (holds(tx.store, lane, requeued.changeId)) return undefined;
        // Back to its place, after every change that was waiting before it: never to the front.
        const back = withPlan(
          enqueue(lane, requeued.changeId),
          requeued.changeId,
          requeued.planHash,
        );
        // Its members clashed: it runs alone next, so the clash ends in one landing and one failure of its own.
        return runsAlone(requeued.reason) ? withAlone(back, [requeued.changeId]) : back;
      }
      case "ChangeParked": {
        // Held for a person's ruling or approval: out of the queue, its plan kept for when it resumes.
        const parked = decodeParked(event.payload);
        return (parked.reason === "awaiting-ruling" || parked.reason === "awaiting-approval") &&
          lane.queue.includes(parked.changeId)
          ? { ...lane, queue: lane.queue.filter((id) => id !== parked.changeId) }
          : undefined;
      }
      case "ProposalApproved": {
        // Back to the front, with the plan it was queued under: it waited for a person, not for its turn.
        const { changeId } = decodeApproved(event.payload);
        const queuedHere = (lane.plans ?? []).some((plan) => plan.changeId === changeId);
        return !queuedHere || holds(tx.store, lane, changeId)
          ? undefined
          : { ...lane, queue: [changeId, ...lane.queue] };
      }
      case "ChangeResumed": {
        // Back to the front, with the plan it was queued under: it waited for a person, not for its turn.
        const { changeId, decisionId } = decodeResumed(event.payload);
        const queuedHere = (lane.plans ?? []).some((plan) => plan.changeId === changeId);
        if (!queuedHere || holds(tx.store, lane, changeId)) return undefined;
        // Resumed by the approve of the drop it was asked about, and by no other ruling: the drop is accepted.
        const drops = (lane.drops ?? []).map((d) =>
          d.changeId === changeId &&
          decisionId === decisionIdOf(shrinkRulingIdOf(changeId, d.verdictId))
            ? { ...d, accepted: true as const }
            : d,
        );
        return {
          ...lane,
          queue: [changeId, ...lane.queue],
          ...(lane.drops === undefined ? {} : { drops }),
        };
      }
      case "ChangeWithdrawn":
      case "ChangeSuperseded":
      case "ChangeBounced":
      // A proposal at another commit is checked again and waits for its own approval: it joins at the back.
      case "ProposalUpdated": {
        const ended = decodeEnded(event.payload);
        // One held for a ruling is in no queue, and its kept plan goes with it.
        const kept = (lane.plans ?? []).some((plan) => plan.changeId === ended.changeId);
        return lane.queue.includes(ended.changeId) ||
          (kept && !holds(tx.store, lane, ended.changeId))
          ? withoutDrops(
              withoutAlone(
                withPlan(
                  unplace({ ...lane, queue: lane.queue.filter((id) => id !== ended.changeId) }, [
                    ended.changeId,
                  ]),
                  ended.changeId,
                  undefined,
                ),
                [ended.changeId],
              ),
              [ended.changeId],
            )
          : undefined;
      }
      case "TrunkAdvanced": {
        const advanced = decodeAdvanced(event.payload);
        if (advanced.projectId !== lane.projectId) return undefined;
        const landed = advanced.landings.map((landing) => landing.changeId);
        // Trunk took the batch in flight: what its verdict counted is trunk's last verdict now.
        const counted =
          lane.active?.landing !== undefined &&
          advanced.landings.some((landing) => landing.candidateId === lane.active?.candidateId)
            ? lane.active.landing
            : undefined;
        const after = withoutDrops(
          counted === undefined ? lane : withTrunkTests(lane, counted),
          landed,
        );
        return {
          ...unplace(after, landed),
          advances: [...lane.advances, { from: advanced.from, to: advanced.to, members: landed }],
          trunkHead: advanced.to,
        };
      }
      case "TrunkSynced": {
        const synced = decodeSynced(event.payload);
        return synced.projectId !== lane.projectId
          ? undefined
          : {
              ...lane,
              advances: [...lane.advances, { from: synced.from, to: synced.to, members: [] }],
              trunkHead: synced.to,
            };
      }
      case "PromotionDeclined": {
        const declined = decodeDeclined(event.payload);
        return lane.active?.batchId === declined.batchId && lane.active.declined !== true
          ? { ...lane, active: { ...lane.active, declined: true } }
          : undefined;
      }
      default:
        return undefined;
    }
  })();
  if (next === undefined) return false;
  putLane(tx.store, next);
  return true;
};

/** The batch's BatchFormed: its id names the KeelVerify instance, its time every composed commit. */
const formedOf = (outbox: (typeof EventOutbox)["Service"], batchId: BatchId) => {
  const formed = outbox.log(batchRef(batchId)).find((event) => event.type === "BatchFormed");
  if (formed === undefined) throw new Error(`batch ${batchId} has no BatchFormed`);
  return formed;
};

/** The batch's VerificationStarted, with the KeelVerify instance it named and when; undefined before it. */
const startedOf = (outbox: (typeof EventOutbox)["Service"], batchId: BatchId) => {
  const started = outbox
    .log(batchRef(batchId))
    .findLast((event) => event.type === "VerificationStarted");
  return started === undefined
    ? undefined
    : { instanceId: decodeStarted(started.payload).instanceId, at: started.at };
};

/** Writes lane state that carries no event (a step's bookkeeping), on the lane's project. */
const noteLane = (lane: Lane, cause: string, update: (lane: Lane) => Lane) =>
  commit({ entity: { kind: "project", id: lane.projectId }, cause }, (tx) => {
    putLane(tx.store, update(laneOf(tx.store, lane.laneId) ?? lane));
    return Result.succeed({ value: undefined, drafts: [] });
  });

const withoutInfra = (lane: Lane, members: readonly ChangeId[]): Lane => ({
  ...lane,
  infra: lane.infra.filter((entry) => !members.includes(entry.changeId)),
});

/** One Candidate command, with what is committed just before its events (a verdict precedes BatchFailed). */
interface Move {
  readonly command: CandidateCommand;
  readonly before?: readonly EventDraft[];
}

/** The commands one transaction takes a batch through, and how they leave the lane. */
interface BatchStep {
  readonly moves: readonly Move[];
  readonly lane: (after: Batch) => Lane;
}

/**
 * Candidate commands on the batch in flight, in one transaction: decide each
 * on the batch as the previous left it, fold the events, update the lane,
 * and commit each move's `before` and then its events. A refusal of any
 * writes nothing.
 */
const onBatch = (
  laneId: string,
  batchId: BatchId,
  cause: string,
  plan: (batch: Batch, lane: Lane, at: number) => BatchStep,
) =>
  commit({ entity: batchRef(batchId), cause, project: laneProject(laneId) }, (tx) => {
    const batch = batchOf(tx.store, batchId);
    const lane = laneOf(tx.store, laneId);
    if (batch === undefined || lane === undefined)
      throw new Error(`lane ${laneId} holds no batch ${batchId}`);
    const step = plan(batch, lane, tx.at);
    let state = batch;
    const drafts: EventDraft[] = [];
    for (const move of step.moves) {
      const decided = decideCandidate(state, move.command, { now: tx.at, batchId });
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      state = fold(state, decided.success, tx.at);
      drafts.push(
        ...(move.before ?? []),
        ...decided.success.map((e) => batchDraft(e, batch.members)),
      );
    }
    tx.store.put(BATCH, batchId, encodeBatch(state));
    putLane(tx.store, step.lane(state));
    return Result.succeed({ value: state, drafts });
  });

/** A call on the change, naming it when the batch is of one: the remedy a lane-issued bounce names. */
const remedy = (batch: Batch, operationId: "submit" | "rebase", title: string): NextAction => {
  const [sole] = batch.members;
  return {
    kind: "call",
    title,
    operationId,
    ...(sole === undefined || batch.members.length > 1 ? {} : { args: { changeId: sole } }),
  };
};

/**
 * An infrastructure failure of the batch at `at`, blamed on `infra` (the
 * Change DO requeues its members) until a batch of one fails that way the
 * INFRA_FAILURE_LIMIT-th time in a row: then on the change, so it bounces
 * visibly, with every reason, instead of looping, if the infrastructure has
 * worked for others since its streak began (another batch verified) or the
 * streak has lasted INFRA_HOLD_MS. Until then the outage is taken to be
 * Keel's: the change is held, requeued at the front again, and `held` says so
 * for the operator. In a batch of several every member counts the failure,
 * and one that reaches the limit runs alone next, where its next such failure
 * is judged so: a forming batch of several can only be failed as `infra` or
 * `textual`, never on one member.
 */
const infraBlame = (
  lane: Lane,
  batch: Batch,
  reason: string,
  at: number,
): {
  readonly attribution: ChangeId | "infra";
  readonly lane: Lane;
  readonly exhausted?: string;
  readonly held?: string;
} => {
  /** A change's streak with this failure added: begun now, when it is the first. */
  const streak = (changeId: ChangeId) => {
    const entry = lane.infra.find((held) => held.changeId === changeId);
    return {
      changeId,
      reasons: [...(entry?.reasons ?? []), reason],
      since: entry?.since ?? at,
      verifiedBefore: entry?.verifiedBefore ?? lane.verified ?? 0,
    };
  };
  const [only] = batch.members;
  const sole = batch.members.length === 1 ? only : undefined;
  if (sole === undefined) {
    const counted = batch.members.map(streak);
    const others = withoutInfra(lane, batch.members);
    const spent = counted.filter((entry) => entry.reasons.length >= INFRA_FAILURE_LIMIT);
    return {
      attribution: "infra",
      lane: withAlone(
        { ...others, infra: [...others.infra, ...counted] },
        spent.map((entry) => entry.changeId),
      ),
    };
  }
  const counted = streak(sole);
  const others = withoutInfra(lane, [sole]);
  const failures = `infra-failure x${counted.reasons.length}: ${counted.reasons.join("; ")}`;
  const kept = { ...others, infra: [...others.infra, counted] };
  if (counted.reasons.length < INFRA_FAILURE_LIMIT) return { attribution: "infra", lane: kept };
  // The infrastructure works for others, or the outage has had its hold: the failure is the change's.
  if ((lane.verified ?? 0) > counted.verifiedBefore || at - counted.since >= INFRA_HOLD_MS)
    return { attribution: sole, lane: others, exhausted: failures };
  return {
    attribution: "infra",
    lane: kept,
    held: `${failures}; held: no batch has verified since ${new Date(counted.since).toISOString()}`,
  };
};

/** What the agent does after its change bounced on repeated infra failures. */
const afterInfra = (batch: Batch, failures: number): readonly NextAction[] => [
  remedy(batch, "submit", "Submit the change again once the infrastructure is fixed"),
  { kind: "wait", title: `The operator has been alerted to ${failures} infra failures in a row` },
];

/**
 * Staging main's head, once it is trunk's: a lane that heard trunk advance
 * moves staging there first (it is staging's one writer), and never forms a
 * batch on any other head, since trunk would only decline it. A move that
 * fails is a defect: the step is retried later, and nothing forms meanwhile.
 */
/**
 * How long the Lane waits on staging's move onto trunk before the step fails
 * into its backoff. The move is a relay, two git requests the adapter bounds
 * at 120 s each. Unbounded, a relay that never answers held the Lane's whole
 * alarm: no batch formed and no green batch was re-offered (the Trunk's own
 * hang on 15 Oct, one object over).
 */
export const STAGING_MOVE_MS = 240_000;

const stagingOnTrunk = (lane: Lane) =>
  Effect.gen(function* () {
    const staging = projectRepos(lane.projectId).staging;
    const head = yield* (yield* CodeHost).head(staging, MAIN).pipe(Effect.orDie);
    const trunk = lane.trunkHead;
    if (trunk === undefined || head === trunk) return head;
    const moved = yield* Effect.result(
      (yield* StagingWriter).fastForward(head, trunk).pipe(Effect.timeout(STAGING_MOVE_MS)),
    );
    if (Result.isFailure(moved))
      return yield* Effect.die(
        new Error(
          `lane ${lane.laneId} forms nothing: staging is at ${head}, trunk at ${trunk}, and the move failed (${moved.failure._tag})`,
        ),
      );
    return trunk;
  });

/** What the lane reads of a queued change before batching it: its declared effects, its unsettled conflicts and its plan. */
interface QueuedRead {
  readonly changeId: ChangeId;
  readonly effects: QueuedChange["effects"];
  readonly unsettled: readonly ChangeId[];
  /** The paths its declared footprint names: two changes whose paths may overlap are batched apart. */
  readonly paths: readonly string[];
  /** Undefined when the change was queued with none, or its plan or its change could not be read: it then joins no one. */
  readonly plan: FlowPlan | undefined;
}

const readQueued = (lane: Lane, namespace: NamespaceId, changeId: ChangeId) =>
  Effect.gen(function* () {
    const read = Option.getOrUndefined(yield* Effect.option((yield* Changes).get(changeId)));
    const planHash = planOf(lane, changeId);
    const plan =
      read === undefined || planHash === undefined
        ? undefined
        : Option.getOrUndefined(yield* Effect.option((yield* PlanStore).get(namespace, planHash)));
    return {
      changeId,
      effects: read?.change.intent.declaredEffects ?? [],
      unsettled: read?.unsettled ?? [],
      paths: read?.change.intent.footprint.map((entry) => entry.path) ?? [],
      plan,
    } satisfies QueuedRead;
  });

/** The members a batch forms with, in queue order, and the plan it runs. */
interface Chosen {
  readonly members: readonly [ChangeId, ...ChangeId[]];
  readonly planHash: ContentHash | undefined;
}

/**
 * Chooses a batch of up to `size` from the queue's front, the head first:
 * belief-aware (`planBatches`: no two changes with an unsettled conflict,
 * opposite effects or a path both declare, and a risky change alone, where risky is a change with no
 * readable plan, one whose plan is a person's (`humanClass`), or one marked to
 * run alone). Members join in queue order while their plans still union, and
 * the union is stored as the batch's plan; a batch of one runs its member's
 * plan unchanged.
 */
const chooseMembers = Effect.fn("integration/chooseMembers")(function* (
  lane: Lane,
  head: ChangeId,
  size: number,
) {
  const alone: Chosen = { members: [head], planHash: planOf(lane, head) };
  const namespace = yield* projectNamespace(lane.projectId).pipe(Effect.orDie);
  const reads = yield* Effect.forEach(
    lane.queue.slice(0, size),
    (changeId) => readQueued(lane, namespace, changeId),
    { concurrency: "unbounded" },
  );
  const queued = reads.map((read): QueuedChange => ({
    id: read.changeId,
    effects: read.effects,
    risky:
      read.plan === undefined || read.plan.humanClass || aloneOf(lane, read.changeId) !== undefined,
  }));
  // Changes whose footprints may touch one path are batched apart, as an unsettled conflict is:
  // speculation then composes the later on the earlier's candidate, so their overlap is an order,
  // never a failed batch.
  const overlapping = reads.flatMap((read, i) =>
    reads
      .slice(i + 1)
      .filter((other) =>
        other.paths.some((path) => read.paths.some((mine) => globsMayOverlap(path, mine))),
      )
      .map((other) => [read.changeId, other.changeId] as const),
  );
  const pairs = [
    ...reads.flatMap((read) => read.unsettled.map((other) => [read.changeId, other] as const)),
    ...overlapping,
  ];
  const [planned = []] = planBatches(queued, failureRate(lane), pairs, 1, size);
  const plans = new Map(reads.map((read) => [read.changeId, read.plan]));
  const joined: { readonly changeId: ChangeId; readonly plan: FlowPlan }[] = [];
  let union: FlowPlan | undefined;
  for (const changeId of planned) {
    const plan = plans.get(changeId);
    if (plan === undefined) continue;
    const tried = unionPlans([plan, ...joined.map((each) => each.plan)]);
    if (Result.isFailure(tried)) continue;
    joined.push({ changeId, plan });
    union = tried.success;
  }
  const [first, ...rest] = joined.map((each) => each.changeId);
  if (first !== head || rest.length === 0 || union === undefined) return alone;
  const planHash = yield* (yield* PlanStore).put(namespace, union);
  return { members: [first, ...rest], planHash } satisfies Chosen;
});

/**
 * Forms the next batch on staging main's head, which is trunk's: the queue's
 * head, alone when it is marked so (under the batch id its bisection named),
 * else with what `chooseMembers` adds, up to `laneBatchSize`. The members are
 * read first; one no longer queued, or a new head, forms nothing, and the
 * step tries again. With `on`, the last batch of the speculation chain, it
 * forms behind it instead: on its candidate, with every member ahead as its
 * predecessors.
 */
const formBatch = Effect.fn("integration/formBatch")(function* (lane: Lane, on?: ActiveBatch) {
  const [head] = lane.queue;
  if (head === undefined) return;
  const store = yield* EntityStore;
  const base = on?.composed?.commitSha ?? (yield* stagingOnTrunk(lane));
  const ahead =
    on === undefined
      ? []
      : [lane.active, ...(lane.behind ?? [])].flatMap((slot) =>
          slot === undefined ? [] : (batchOf(store, slot.batchId)?.members ?? []),
        );
  const named = aloneOf(lane, head);
  const settings = yield* (yield* Projects).settings(lane.projectId).pipe(Effect.orDie);
  const size = named === undefined ? laneBatchSize(lane, settings.maxBatchSize) : 1;
  const chosen: Chosen =
    size === 1
      ? { members: [head], planHash: planOf(lane, head) }
      : yield* chooseMembers(lane, head, size);
  const ids = yield* Ids;
  const batchId = named?.batchId ?? (yield* ids.next("bat"));
  const candidateId = yield* ids.next("cnd");
  const members = chosen.members;
  yield* commit(
    { entity: batchRef(batchId), cause: `form:${batchId}`, project: lane.projectId },
    (tx): Result.Result<Transition<undefined>, CandidateRejection> => {
      const now = laneOf(tx.store, lane.laneId) ?? lane;
      const tail = (now.behind ?? []).at(-1) ?? now.active;
      if (
        (on === undefined ? now.active !== undefined : tail?.batchId !== on.batchId) ||
        now.queue[0] !== head ||
        members.some((member) => !now.queue.includes(member))
      )
        return Result.succeed({ value: undefined, drafts: [] });
      return Result.map(
        decideCandidate(
          undefined,
          {
            _tag: "Form",
            laneId: lane.laneId,
            projectId: lane.projectId,
            members,
            base,
            predecessors: ahead,
            attempt: 0,
            chainEpoch: now.chainEpoch ?? 0,
          },
          { now: tx.at, batchId },
        ),
        (events) => {
          // Subscribed before the append, so BatchFormed itself reaches them.
          for (const member of members)
            tx.outbox.subscribe(`change:${member}`, MEMBER_EVENTS, changeRef(member));
          tx.outbox.subscribe(`trunk:${lane.projectId}`, ["BatchVerified"]);
          tx.store.put(BATCH, batchId, encodeBatch(fold(undefined, events, tx.at)));
          const planHash = chosen.planHash;
          const left = members.reduce((acc, member) => withPlan(acc, member, undefined), now);
          const slot: ActiveBatch = {
            batchId,
            candidateId,
            ...(planHash === undefined ? {} : { planHash }),
            ...(on === undefined ? {} : { on: on.batchId }),
          };
          putLane(tx.store, {
            ...withoutAlone(left, members),
            queue: now.queue.filter((id) => !members.includes(id)),
            ...(on === undefined ? { active: slot } : { behind: [...(now.behind ?? []), slot] }),
          });
          return { value: undefined, drafts: events.map((e) => batchDraft(e, members)) };
        },
      );
    },
  ).pipe(Effect.orDie);
});

/**
 * What MergeBox refuses for its own sake and never the batch's: a gate with
 * no room (`box-unavailable`), a box that could not fetch, push or answer
 * (`box-failed`), and a check of the box that did not pass (`box-check`).
 */
export const BOX_INFRA_REASONS: ReadonlySet<string> = new Set([
  "box-unavailable",
  "box-failed",
  "box-check",
]);

/** The id a verdict the Lane issues is minted with. */
type IssuedId = Extract<CandidateCommand, { readonly _tag: "RefuseBundle" }>["verdictId"];

/**
 * A batch failed on the infrastructure before verification, by `refuse`
 * (its composition or its bundle refused, blamed as `infraBlame` says): the
 * Change DO requeues the members and the verdict holds them, waiting, until
 * a batch of one is failed that way the INFRA_FAILURE_LIMIT-th time in a
 * row: then the change bounces, told to submit again once the
 * infrastructure is back. A refusal for want of `capacity` is counted toward
 * no limit.
 */
const holdOnInfra = Effect.fn("integration/holdOnInfra")(function* (
  lane: Lane,
  batch: Batch,
  cause: string,
  refuse: (verdictId: IssuedId, attribution: ChangeId | "infra") => CandidateCommand,
  refusal: string,
  wait: string,
  capacity = false,
  retryAfterMs?: number,
) {
  const verdictId = yield* (yield* Ids).next("vrd");
  let exhausted: string | undefined;
  let held: string | undefined;
  yield* onBatch(lane.laneId, batch.id, cause, (_, now, at) => {
    const infra = capacity ? uncounted(now) : infraBlame(now, batch, refusal, at);
    exhausted = infra.exhausted;
    held = infra.held;
    return {
      moves: [
        {
          command: refuse(verdictId, infra.attribution),
          before: [
            verdictDraft(
              VerdictIssued.make({
                verdictId,
                subject: batch.id,
                outcome: infra.exhausted === undefined ? "hold" : "bounce",
                evidence: infra.exhausted === undefined ? [refusal] : [infra.exhausted, refusal],
                nextActions:
                  infra.exhausted === undefined
                    ? [{ kind: "wait", title: wait }]
                    : afterInfra(batch, INFRA_FAILURE_LIMIT),
              }),
              batch.members,
            ),
          ],
        },
      ],
      lane: () => ({
        ...infra.lane,
        active: undefined,
        ...(retryAfterMs === undefined ? {} : { boxWait: at + retryAfterMs }),
      }),
    };
  }).pipe(Effect.orDie);
  if (exhausted !== undefined) yield* Effect.logError(`lane ${lane.laneId}: ${exhausted}`);
  if (held !== undefined) yield* Effect.logError(`lane ${lane.laneId}: ${held}`);
});

/** A refused composition as evidence: its reason, its paths, and what failed where the composer saw it. */
const refusalEvidence = (refused: CompositionRefused) =>
  `composition-refused: ${refused.reason} ${refused.paths.join(" ")}`.trimEnd() +
  (refused.detail === undefined ? "" : `: ${refused.detail}`);

/** How many trunk commits a textual bounce reads back for what it conflicts with, before it says it stopped short. */
export const COUNTERPART_WALK = 64;

/** The conflicting paths a textual bounce asks `why` about, at most. */
const WHY_PATHS = 3;

/** What a textual bounce conflicts with on trunk, newest first, and how many commits the walk read when it stopped short of the change's base. */
interface Counterparts {
  readonly found: readonly Counterpart[];
  readonly cut?: number;
}

/**
 * The trunk commits in (the change's base, the batch's base] that changed a
 * conflicting path, newest first: trunk's first-parent chain, each commit
 * diffed against its parent, read back to the base or COUNTERPART_WALK
 * commits. Only a batch of one bounces on a textual conflict (a bigger one
 * runs each member alone next), so the other side is always trunk.
 */
const counterpartsOf = Effect.fn("integration/counterpartsOf")(function* (
  staging: RepoRef,
  head: CommitSha,
  base: CommitSha,
  paths: readonly string[],
) {
  const host = yield* CodeHost;
  const chain = yield* host.log(staging, head, COUNTERPART_WALK);
  const reached = chain.findIndex((landed) => landed.sha === base);
  const since = reached === -1 ? chain : chain.slice(0, reached);
  const found = yield* Effect.forEach(since, (landed) => {
    const [parent] = landed.parents;
    if (parent === undefined) return Effect.succeed([]);
    return host.diffTrees(staging, parent, landed.sha).pipe(
      Effect.map((changed): Counterpart[] => {
        const touched = new Set(changed.map((c) => c.path));
        const hit = paths.filter((path) => touched.has(path));
        if (hit.length === 0) return [];
        const changeId = changeIdOf(landed.message);
        return [
          { ...(changeId === undefined ? {} : { changeId }), commitSha: landed.sha, paths: hit },
        ];
      }),
    );
  });
  return {
    found: found.flat(),
    ...(reached === -1 ? { cut: since.length } : {}),
  } satisfies Counterparts;
});

/** Each counterpart as evidence, and the walk's cut when it stopped short of the change's base. */
const counterpartEvidence = ({ found, cut }: Counterparts, base: CommitSha): string[] => [
  ...found.map(({ changeId, commitSha, paths }) =>
    changeId === undefined
      ? `conflicts with trunk commit ${commitSha.slice(0, 12)}, which Keel did not land, on ${paths.join(", ")}`
      : `conflicts with ${changeId}, landed as ${commitSha.slice(0, 12)}, on ${paths.join(", ")}`,
  ),
  ...(cut === undefined
    ? []
    : [
        `and more may conflict: Keel read ${cut} trunk commits back without reaching the change's base ${base.slice(0, 12)}`,
      ]),
];

/** A `why` on each conflicting path, up to WHY_PATHS: what was decided there, naming the change that landed on it since the base when Keel knows one. */
const whyActions = (
  projectId: ProjectId,
  paths: readonly string[],
  { found }: Counterparts,
): NextAction[] =>
  paths.slice(0, WHY_PATHS).map((path) => {
    const landed = found.find((c) => c.changeId !== undefined && c.paths.includes(path))?.changeId;
    return {
      kind: "read",
      title: `Ask why ${path} is as it is: ${landed ?? "trunk"} changed it since your base`,
      operationId: "why",
      args: { project: projectId, path },
    };
  });

/** A composition MergeBox refused for its own sake: held on the infrastructure, with what failed in the box. */
const holdForBox = (lane: Lane, batch: Batch, refused: CompositionRefused) =>
  holdOnInfra(
    lane,
    batch,
    `compose-refused:${batch.id}`,
    (verdictId, attribution) => ({ _tag: "RefuseComposition", verdictId, attribution }),
    refusalEvidence(refused),
    "MergeBox could not compose the batch, through no fault of the change: Keel puts it back in the queue",
    refused.reason === "box-unavailable",
    refused.reason === "box-unavailable" ? refused.retryAfterMs : undefined,
  );

/** What a gate refuses for a namespace whose verification spend is stopped. */
export const NAMESPACE_HALTED = "namespace-halted";

/**
 * A composition the gate refused because the namespace is halted: every
 * member bounces once, blamed on none, with what its owner does next.
 */
const bounceHalted = Effect.fn("integration/bounceHalted")(function* (
  lane: Lane,
  batch: Batch,
  refused: CompositionRefused,
) {
  const namespace = yield* Effect.option(projectNamespace(lane.projectId));
  const verdictId = yield* (yield* Ids).next("vrd");
  yield* onBatch(lane.laneId, batch.id, `compose-refused:${batch.id}`, (_, now) => ({
    moves: [
      {
        command: { _tag: "RefuseComposition", verdictId, attribution: "halted" },
        before: [
          verdictDraft(
            VerdictIssued.make({
              verdictId,
              subject: batch.id,
              outcome: "bounce",
              evidence: [
                `${refusalEvidence(refused)}; the change itself passed nothing and failed nothing`,
              ],
              nextActions: Option.isSome(namespace) ? haltedActions(namespace.value) : [],
            }),
            batch.members,
          ),
        ],
      },
    ],
    lane: () => ({ ...withoutInfra(now, batch.members), active: undefined }),
  })).pipe(Effect.orDie);
});

/** A composition refused for the batch's sake: the verdict, then BatchFailed (on the change of a batch of one), in one transaction. */
const refuseComposition = Effect.fn("integration/refuseComposition")(function* (
  lane: Lane,
  batch: Batch,
  refused: CompositionRefused,
  members: readonly CandidateMember[],
) {
  if (BOX_INFRA_REASONS.has(refused.reason)) {
    yield* holdForBox(lane, batch, refused);
    return;
  }
  if (refused.reason === NAMESPACE_HALTED) {
    yield* bounceHalted(lane, batch, refused);
    return;
  }
  // A batch of one bounces on the paths: name what landed on them since the change's base.
  const [sole] = members;
  const read =
    sole === undefined || members.length > 1 || refused.paths.length === 0
      ? undefined
      : yield* Effect.result(
          counterpartsOf(
            projectRepos(lane.projectId).staging,
            batch.base,
            sole.base,
            refused.paths,
          ),
        );
  if (read !== undefined && Result.isFailure(read))
    yield* Effect.logWarning(
      `lane ${lane.laneId}: no counterparts for ${batch.id}: ${read.failure._tag}`,
    );
  const counterparts = read !== undefined && Result.isSuccess(read) ? read.success : undefined;
  const verdictId = yield* (yield* Ids).next("vrd");
  yield* onBatch(lane.laneId, batch.id, `compose-refused:${batch.id}`, (_, now) => ({
    moves: [
      {
        command: { _tag: "RefuseComposition", verdictId },
        before: [
          verdictDraft(
            VerdictIssued.make({
              verdictId,
              subject: batch.id,
              outcome: "bounce",
              evidence: [
                refusalEvidence(refused),
                ...(counterparts === undefined || sole === undefined
                  ? []
                  : counterpartEvidence(counterparts, sole.base)),
              ],
              // Trunk moved under the change: rebase puts trunk's head on the workspace's keel/trunk, and the agent merges it (never a force push).
              nextActions: [
                remedy(
                  batch,
                  "rebase",
                  `Rebase the change onto trunk's head (it was ${batch.base} at this bounce): Keel puts it on your workspace's keel/trunk branch`,
                ),
                ...(counterparts === undefined
                  ? []
                  : whyActions(lane.projectId, refused.paths, counterparts)),
                remedy(
                  batch,
                  "submit",
                  `Then run git fetch origin keel/trunk && git merge FETCH_HEAD, resolve ${refused.paths.join(", ") || "the conflict"}, push, and submit again`,
                ),
              ],
              ...(counterparts === undefined ? {} : { counterparts: counterparts.found }),
            }),
            batch.members,
          ),
        ],
      },
    ],
    lane: () => ({ ...withoutInfra(now, batch.members), active: undefined }),
  })).pipe(Effect.orDie);
});

/**
 * A batch whose member was queued with no compiled plan (it was queued
 * before the lane kept plans): the bounce, with the remedy of submitting
 * again so Precheck compiles and stores one, through the forming batch's
 * refusal, in one transaction. Nothing is composed or verified without it.
 */
const refusePlanless = Effect.fn("integration/refusePlanless")(function* (
  lane: Lane,
  batch: Batch,
) {
  const verdictId = yield* (yield* Ids).next("vrd");
  yield* onBatch(lane.laneId, batch.id, `plan-missing:${batch.id}`, (_, now) => ({
    moves: [
      {
        command: { _tag: "RefuseComposition", verdictId },
        before: [
          verdictDraft(
            VerdictIssued.make({
              verdictId,
              subject: batch.id,
              outcome: "bounce",
              evidence: [
                `plan-missing: ${batch.members.join(", ")} was queued with no compiled plan, so nothing can verify it`,
              ],
              nextActions: [
                remedy(
                  batch,
                  "submit",
                  "Submit the change again: Precheck compiles its plan, and the lane queues it with that plan",
                ),
              ],
            }),
            batch.members,
          ),
        ],
      },
    ],
    lane: () => ({ ...withoutInfra(now, batch.members), active: undefined }),
  })).pipe(Effect.orDie);
});

/**
 * Composes the batch onto its base in staging, one restacked commit per
 * member; a batch with no plan is refused first. Every member's change,
 * workspace and agent are read at once, in batch order.
 */
const composeBatch = Effect.fn("integration/composeBatch")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
) {
  if (active.planHash === undefined) {
    if (isBehind(lane, batch.id)) {
      yield* cancelBehind(lane.laneId, batch.id, batch.id, "no plan");
      return;
    }
    yield* refusePlanless(lane, batch);
    return;
  }
  const changes = yield* Changes;
  const directory = yield* AgentDirectory;
  const namespaces = yield* Namespaces;
  // A person by the handle of their own namespace, an agent by the one the directory gave it.
  const handleOf = (actor: CommandActor) => {
    const parts = actorParts(actor);
    return parts.kind === "agent"
      ? Effect.map(directory.findAgent(parts.id), (agent) => Option.getOrUndefined(agent)?.handle)
      : Effect.map(namespaces.byId(parts.id), (place) => Option.getOrUndefined(place)?.handle);
  };
  const members = yield* Effect.forEach(
    batch.members,
    (changeId) =>
      Effect.gen(function* () {
        const [{ change }, workspace] = yield* Effect.all(
          [changes.get(changeId), changes.workspace(changeId)],
          { concurrency: 2 },
        );
        const { agentId, proposal } = change;
        const agent = agentId === undefined ? Option.none() : yield* directory.findAgent(agentId);
        if (change.commitSha === undefined)
          return yield* Effect.die(new Error(`${changeId} is in a batch with no submitted commit`));
        // A proposal is its proposer's, by the commit of the fork it was approved at.
        const proposer =
          proposal === undefined
            ? undefined
            : {
                actor: proposal.proposer,
                handle: yield* handleOf(proposal.proposer),
                from: { project: proposal.fork, commit: change.commitSha },
              };
        return {
          changeId,
          repo: workspace.repo,
          base: workspace.baseSha,
          head: change.commitSha,
          title: change.intent.goal,
          // The agent the change belongs to, as the gate authenticated it: never what its commit says.
          // Its handle is the directory's: given at sign-up and never after, so every compose of a
          // member reads the same one (an agent a person enrolled has none, and is written by its id).
          // The run is the one that holds the change.
          ...(agentId === undefined
            ? {}
            : {
                agent: {
                  id: agentId,
                  handle: Option.getOrUndefined(agent)?.handle,
                  run: change.run?.id,
                },
              }),
          ...(proposer === undefined ? {} : { proposer }),
        } satisfies CandidateMember;
      }).pipe(Effect.orDie),
    { concurrency: "unbounded" },
  );
  const formed = formedOf(yield* EventOutbox, batch.id);
  const composed = yield* Effect.result(
    (yield* CandidateComposer).compose({
      candidateId: active.candidateId,
      staging: projectRepos(lane.projectId).staging,
      base: batch.base,
      at: formed.at,
      members,
      // Behind the batch in flight a refusal is decided again in flight: no cold box for it here.
      ...(isBehind(lane, batch.id) ? { gitcoreOnly: true as const } : {}),
    }),
  );
  if (Result.isFailure(composed)) {
    // Behind the batch in flight, a refusal is decided again once the batch is in flight itself.
    if (isBehind(lane, batch.id)) {
      yield* cancelBehind(
        lane.laneId,
        batch.id,
        batch.id,
        `compose refused: ${composed.failure.reason}`,
      );
      return;
    }
    yield* refuseComposition(lane, batch, composed.failure, members);
    return;
  }
  const candidate = composed.success;
  yield* onBatch(lane.laneId, batch.id, `assemble:${batch.id}`, (_, now) => ({
    moves: [
      {
        command: {
          _tag: "Assemble",
          candidateId: active.candidateId,
          treeSha: candidate.treeSha,
          composer: candidate.composer,
          tier: candidate.tier,
          tierReason: candidate.tierReason,
          ...(candidate.boxCheck === undefined ? {} : { boxCheck: candidate.boxCheck }),
        },
      },
    ],
    lane: () =>
      withSlot(now, batch.id, (slot) => ({
        ...slot,
        composed: { commitSha: candidate.commitSha, commits: candidate.commits },
      })),
  })).pipe(Effect.orDie);
});

/**
 * Who a refused bundle entry is on: the member whose restacked commit adds
 * it (or turns an entry into it), or `infra` when the base already held it.
 * No bisection: the diffs along the chain say exactly.
 */
export const bundleBlame = Effect.fn("integration/bundleBlame")(function* (
  staging: RepoRef,
  path: string,
  base: CommitSha,
  commits: readonly { readonly changeId: ChangeId; readonly sha: CommitSha }[],
) {
  const host = yield* CodeHost;
  let parent = base;
  for (const step of commits) {
    const changed = yield* host.diffTrees(staging, parent, step.sha).pipe(Effect.orDie);
    if (
      changed.some(
        (entry) =>
          entry.path === path && (entry.change === "added" || entry.change === "type-changed"),
      )
    )
      return step.changeId;
    parent = step.sha;
  }
  return "infra" as const;
});

/**
 * Bundles the composed candidate for KeelVerify. A refused bundle fails the
 * batch through RefuseBundle with the verdict first: on the member whose
 * commit introduced the entry, or `infra` when the base already held it.
 */
const bundleBatch = Effect.fn("integration/bundleBatch")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
  composed: NonNullable<ActiveBatch["composed"]>,
) {
  const staging = projectRepos(lane.projectId).staging;
  // A project with no place never has a batch: its Precheck ends before it compiles a plan.
  const namespace = yield* projectNamespace(lane.projectId).pipe(Effect.orDie);
  const bundled = yield* Effect.result(
    (yield* CandidateBundles).bundle(namespace, staging, composed.commitSha, lane.lastBundle),
  );
  if (Result.isSuccess(bundled)) {
    yield* noteLane(lane, `bundled:${batch.id}`, (now) => ({
      ...withSlot(now, batch.id, (slot) => ({ ...slot, bundle: bundled.success })),
      lastBundle: bundled.success,
    }));
    return;
  }
  const refused = bundled.failure;
  if (isBehind(lane, batch.id)) {
    yield* cancelBehind(lane.laneId, batch.id, batch.id, `bundle refused: ${refused.reason}`);
    return;
  }
  const blame =
    refused.path === undefined
      ? "infra"
      : yield* bundleBlame(staging, refused.path, batch.base, composed.commits);
  const verdictId = yield* (yield* Ids).next("vrd");
  let exhausted: string | undefined;
  let held: string | undefined;
  yield* onBatch(lane.laneId, batch.id, `bundle-refused:${batch.id}`, (_, now, at) => {
    const evidence = [
      `bundle-refused: ${refused.reason}`,
      ...(blame === "infra" && refused.path !== undefined
        ? [`bundle-refused-in-base: ${refused.path}`]
        : []),
    ];
    const infra = blame === "infra" ? infraBlame(now, batch, evidence.join("; "), at) : undefined;
    exhausted = infra?.exhausted;
    held = infra?.held;
    const attribution = infra?.attribution ?? blame;
    const nextActions =
      infra === undefined
        ? [
            remedy(
              batch,
              "submit",
              `Remove ${refused.path ?? "the entry"} (a bundle carries regular files only), then submit it again`,
            ),
          ]
        : infra.exhausted === undefined
          ? undefined
          : afterInfra(batch, INFRA_FAILURE_LIMIT);
    return {
      moves: [
        {
          command: { _tag: "RefuseBundle", verdictId, attribution },
          before: [
            verdictDraft(
              VerdictIssued.make({
                verdictId,
                subject: batch.id,
                outcome: "bounce",
                evidence:
                  infra?.exhausted === undefined ? evidence : [infra.exhausted, ...evidence],
                ...(nextActions === undefined ? {} : { nextActions }),
              }),
              batch.members,
            ),
          ],
        },
      ],
      lane: () => ({
        ...(infra?.lane ?? withoutInfra(now, batch.members)),
        active: undefined,
      }),
    };
  }).pipe(Effect.orDie);
  if (exhausted !== undefined)
    yield* Effect.logError(
      `lane ${lane.laneId} bounced ${batch.members.join(", ")} on ${exhausted}`,
    );
  if (held !== undefined) yield* Effect.logError(`lane ${lane.laneId}: ${held}`);
});

/** The batch's plan. Composition refuses a batch with none, so one past it always has its plan. */
const plannedOf = (active: ActiveBatch) =>
  active.planHash === undefined
    ? Effect.die(new Error(`batch ${active.batchId} got past composition with no plan`))
    : Effect.succeed(active.planHash);

const INSTANCE_PREFIX = "keel-verify-";
/** What the platform allows in an instance id, and how long one may be. */
const INSTANCE_NAME = /^[A-Za-z0-9_-]+$/;
const INSTANCE_ID_MAX = 100;

/**
 * The KeelVerify instance of a lane's batch,
 * `keel-verify-<projectId>-<laneName>-<BatchFormed eventId>`. It is named by
 * the batch's BatchFormed, so a retried start starts nothing new, and by its
 * lane, because the platform's report that an instance ended carries nothing
 * but this id. A lane whose name such an id cannot carry is a defect.
 */
export const instanceOf = (laneId: string, formedEventId: string): string => {
  const project = laneProject(laneId);
  const name = laneId.slice(`lane:${project}:`.length);
  const id = `${INSTANCE_PREFIX}${project}-${name}-${formedEventId}`;
  if (!INSTANCE_NAME.test(name) || id.length > INSTANCE_ID_MAX)
    throw new Error(
      `lane ${laneId} cannot name a KeelVerify instance: ${id} must be letters, digits, _ and -, and at most ${INSTANCE_ID_MAX} characters`,
    );
  return id;
};

/** The lane a KeelVerify instance verifies for, read from its id; undefined for an id `instanceOf` did not make. */
export const laneOfInstance = (instanceId: string): string | undefined => {
  const match = /^keel-verify-([^-]+)-(.+)-([^-]+)$/.exec(instanceId);
  const [project, name] = [match?.[1], match?.[2]];
  if (project === undefined || name === undefined) return undefined;
  return Schema.is(ProjectId)(project) ? `lane:${project}:${name}` : undefined;
};

/**
 * Commits VerificationStarted, then creates the KeelVerify instance: its
 * verdict can never reach a batch not yet Verifying. The start is retried
 * until it is recorded, and a second start of one id starts nothing.
 */
const verifyBatch = Effect.fn("integration/verifyBatch")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
  bundle: ContentHash,
) {
  const planHash = yield* plannedOf(active);
  const instanceId = instanceOf(lane.laneId, formedOf(yield* EventOutbox, batch.id).eventId);
  if (batch.state === "assembled")
    yield* onBatch(lane.laneId, batch.id, `verify:${batch.id}`, (_, now) => ({
      moves: [{ command: { _tag: "StartVerification", instanceId, planHash } }],
      lane: () => now,
    })).pipe(Effect.orDie);
  yield* (yield* BatchVerification).start(instanceId, {
    projectId: lane.projectId,
    namespace: yield* projectNamespace(lane.projectId).pipe(Effect.orDie),
    jobId: `${batch.id}#${batch.attempt}`,
    laneId: lane.laneId,
    candidateId: active.candidateId,
    bundle,
    fence: { batchId: batch.id, attempt: batch.attempt, chainEpoch: batch.chainEpoch },
    planHash,
    members: batch.members,
    ...(active.composed === undefined ? {} : { candidateCommit: active.composed.commitSha }),
  });
  yield* noteLane(lane, `verify-started:${batch.id}`, (now) =>
    withSlot(now, batch.id, (slot) => ({ ...slot, started: true })),
  );
});

/**
 * A project whose verification is off (S-0's negative control, operator-set
 * and audited): the batch is verified without KeelVerify or a bundle, its
 * verdict and BatchVerified stamped `verified: false`, in one transaction.
 */
const passUnverified = Effect.fn("integration/passUnverified")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
) {
  const planHash = yield* plannedOf(active);
  const formed = formedOf(yield* EventOutbox, batch.id);
  const verdictId = yield* (yield* Ids).next("vrd");
  const fence = { attempt: batch.attempt, chainEpoch: batch.chainEpoch };
  yield* onBatch(lane.laneId, batch.id, `unverified:${batch.id}`, (_, now) => ({
    moves: [
      {
        command: {
          _tag: "StartVerification",
          instanceId: `unverified-${formed.eventId}`,
          planHash,
        },
      },
      {
        command: { _tag: "Verified", verdictId, verified: false, ...fence },
        before: [
          verdictDraft(
            VerdictIssued.make({
              verdictId,
              subject: batch.id,
              outcome: "land",
              evidence: ["verification-off: the project's verification is off, so no plan ran"],
              verified: false,
            }),
            batch.members,
          ),
        ],
      },
    ],
    lane: () =>
      withOutcomes(
        withoutInfra(now, batch.members),
        batch.members.map(() => "pass" as const),
      ),
  })).pipe(Effect.orDie);
});

/**
 * Follows one trunk advance: a green batch whose members it landed is
 * Promoted. Staging is left where it is: `stagingOnTrunk`, staging's one
 * mover, takes it to the head the lane heard before the next batch forms.
 */
const followTrunk = Effect.fn("integration/followTrunk")(function* (
  lane: Lane,
  advance: Lane["advances"][number],
) {
  const active = lane.active;
  const batch = active === undefined ? undefined : batchOf(yield* EntityStore, active.batchId);
  if (batch?.state === "green" && batch.members.every((m) => advance.members.includes(m)))
    yield* onBatch(lane.laneId, batch.id, `promote:${batch.id}`, (_, now) => {
      // The first batch behind it is in flight now: it was composed on this one's candidate, trunk's head.
      const [next, ...rest] = now.behind ?? [];
      return {
        moves: [{ command: { _tag: "Promote", trunkSha: advance.to } }],
        lane: () => ({
          ...withoutInfra(now, batch.members),
          active: next,
          behind: rest,
        }),
      };
    }).pipe(Effect.orDie);
  yield* noteLane(lane, `followed:${advance.from}..${advance.to}`, (now) => ({
    ...now,
    advances: now.advances.filter((a) => a.from !== advance.from || a.to !== advance.to),
  }));
});

/**
 * Trunk declined the green batch in flight (its base is no longer trunk's
 * head, or a freeze stopped its group): it is invalidated, which sends each
 * member back to the queue through its Change DO's ChangeRequeued, to be
 * restacked onto trunk's head and verified again.
 */
const invalidateBatch = Effect.fn("integration/invalidateBatch")(function* (
  lane: Lane,
  batchId: BatchId,
) {
  // Only a green batch reaches trunk; one already terminal is just cleared.
  yield* onBatch(lane.laneId, batchId, `invalidate:${batchId}`, (batch, now) => ({
    moves: batch.state === "green" ? [{ command: { _tag: "Invalidate" } }] : [],
    lane: () => ({ ...now, active: undefined }),
  })).pipe(Effect.orDie);
});

/** The green batch in flight that trunk has not answered (no TrunkAdvanced or PromotionDeclined yet), with its BatchVerified. */
const unanswered = (store: Store, outbox: (typeof EventOutbox)["Service"], laneId: string) => {
  const lane = laneOf(store, laneId);
  const active = lane?.active;
  if (lane === undefined || active === undefined || active.declined === true) return undefined;
  if (batchOf(store, active.batchId)?.state !== "green") return undefined;
  const verified = outbox
    .log(batchRef(active.batchId))
    .findLast((event) => event.type === "BatchVerified");
  return verified === undefined ? undefined : { lane, active, verified };
};

/**
 * When the lane next re-offers its green batch to trunk, or undefined when
 * nothing waits on trunk. It is derived from state, so arming it again after
 * every step never postpones it.
 */
export const reofferDue = Effect.fn("integration/reofferDue")(function* (laneId: string) {
  const found = unanswered(yield* EntityStore, yield* EventOutbox, laneId);
  if (found === undefined) return undefined;
  const last = found.active.reoffered;
  return (last?.at ?? found.verified.at) + reofferDelay(last?.count ?? 0);
});

/**
 * Until when the lane forms nothing at `now`: the later of the times still to
 * come of its namespace's container-minutes (`notBefore`) and its box gate
 * (`boxWait`). Undefined when neither is.
 */
const waitsAt = (lane: Lane, now: number): number | undefined => {
  const waits = [lane.notBefore, lane.boxWait].filter(
    (until): until is number => until !== undefined && until > now,
  );
  return waits.length === 0 ? undefined : Math.max(...waits);
};

/**
 * When the lane steps again for its namespace: the time it forms nothing
 * until (`waitsAt`), while changes wait in the queue. Undefined otherwise.
 */
export const budgetDue = Effect.fn("integration/budgetDue")(function* (laneId: string) {
  const lane = laneOf(yield* EntityStore, laneId);
  if (lane === undefined || lane.queue.length === 0) return undefined;
  return waitsAt(lane, yield* (yield* Clock).now);
});

/**
 * The namespace's box gate freed a box the lane was refused one of: the lane
 * no longer waits on the gate. It still waits on its container-minutes.
 */
export const boxFreed = Effect.fn("integration/boxFreed")(function* (laneId: string) {
  const lane = laneOf(yield* EntityStore, laneId);
  if (lane?.boxWait === undefined) return;
  const at = yield* (yield* Clock).now;
  yield* noteLane(lane, `box-freed:${at}`, ({ boxWait: _freed, ...rest }) => rest).pipe(
    Effect.orDie,
  );
});

/** A BatchVerified handed to trunk again: the same event under a fresh dedupe key. */
export interface Reoffer {
  readonly subscriber: string;
  readonly envelope: EventEnvelope;
  readonly count: number;
}

/**
 * Re-offers the green batch's BatchVerified to `trunk:<prj>`. Delivery is at
 * least once, but a receiver that records an event and has no reaction to it
 * spends it: the Trunk deployed before promotion did, and the lane waited on
 * it for good. The copy changes only its dedupe key, to `<key>#reoffer-<n>`,
 * so the Trunk takes it; it holds a batch once and ignores one it promoted.
 * The count is committed here; the Lane DO delivers.
 */
export const reofferVerified = Effect.fn("integration/reofferVerified")(function* (laneId: string) {
  const store = yield* EntityStore;
  const found = unanswered(store, yield* EventOutbox, laneId);
  if (found === undefined) return undefined;
  const { lane, active, verified } = found;
  const count = (active.reoffered?.count ?? 0) + 1;
  const at = yield* (yield* Clock).now;
  yield* noteLane(lane, `reoffer:${active.batchId}#${count}`, (now) =>
    now.active?.batchId === active.batchId
      ? { ...now, active: { ...now.active, reoffered: { count, at } } }
      : now,
  );
  return {
    subscriber: `trunk:${lane.projectId}`,
    envelope: { ...verified, dedupeKey: `${verified.dedupeKey}#reoffer-${count}` },
    count,
  } satisfies Reoffer;
});

/**
 * Stops the lane for good, when its project is deleted: its queue, its batch
 * in flight and the advances it had still to follow are dropped, so no batch
 * forms and none is re-offered to trunk, and from here on it hears no event
 * and takes no verdict. `by` is who asked. Destroying again is a no-op.
 */
export const destroyLane = Effect.fn("integration/destroyLane")(function* (
  laneId: string,
  by: string,
) {
  const projectId = laneProject(laneId);
  yield* commit(
    { entity: { kind: "project", id: projectId }, cause: `destroy:${laneId}`, project: projectId },
    (tx) => {
      tx.store.put(DESTROYED, laneId, { by, at: tx.at });
      if (laneOf(tx.store, laneId) !== undefined) putLane(tx.store, emptyLane(laneId));
      return Result.succeed({ value: undefined, drafts: [] });
    },
  );
});

type StepStage = NonNullable<ActiveBatch["attempt"]>["stage"];

/**
 * A batch whose compose, bundle or start failed STEP_FAILURES_BEFORE_INFRA
 * times, failed on the infrastructure where it stands so the lane moves on.
 * A forming batch's composition or an assembled one's bundle is refused and
 * held, as MergeBox's own failures are; a verifying batch whose instance was
 * never made is parked, as KeelVerify's infra failures are. Either requeues
 * the change, and a batch of one failed so the INFRA_FAILURE_LIMIT-th time
 * in a row bounces.
 */
const failOnSteps = Effect.fn("integration/failOnSteps")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
  failed: readonly string[],
) {
  const evidence = `step-failed x${failed.length}: ${failed.join("; ")}`;
  yield* Effect.logError(
    `lane ${lane.laneId} failed ${batch.id} on the infrastructure: ${evidence}`,
  );
  if (batch.state === "verifying") {
    yield* issue(
      lane.laneId,
      batch,
      `step-failed:${batch.id}`,
      {
        verdictId: yield* (yield* Ids).next("vrd"),
        outcome: "park",
        planHash: yield* plannedOf(active),
        evidence: [evidence],
        failingTests: [],
      },
      { attempt: batch.attempt, chainEpoch: batch.chainEpoch },
    ).pipe(Effect.orDie);
    return;
  }
  yield* holdOnInfra(
    lane,
    batch,
    `step-failed:${batch.id}`,
    (verdictId, attribution) =>
      batch.state === "forming"
        ? { _tag: "RefuseComposition", verdictId, attribution }
        : { _tag: "RefuseBundle", verdictId, attribution },
    evidence,
    "Keel could not compose, bundle or start verifying the batch, through no fault of the change: Keel puts it back in the queue",
  );
});

/**
 * Marks the batch's `stage` as attempted before the step runs it, and
 * answers the batch as marked. The same stage still marked by a step before
 * is an attempt that did not get through, failed with the error the Lane DO
 * recorded or, with none, by an invocation that died: every such attempt of
 * the batch counts, at any of its stages. At STEP_FAILURES_BEFORE_INFRA the
 * batch is failed on the infrastructure instead, and the answer is undefined.
 */
const attempt = Effect.fn("integration/attempt")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
  stage: StepStage,
) {
  const failed =
    active.attempt?.stage === stage
      ? [
          ...(active.failed ?? []),
          `${stage}: ${active.attempt.error ?? "the step died before it finished"}`,
        ]
      : (active.failed ?? []);
  if (failed.length >= STEP_FAILURES_BEFORE_INFRA) {
    yield* failOnSteps(lane, active, batch, failed);
    return undefined;
  }
  const marked: ActiveBatch = {
    ...active,
    attempt: { stage },
    ...(failed.length === 0 ? {} : { failed }),
  };
  yield* noteLane(lane, `attempt:${batch.id}:${stage}:${failed.length}`, (now) =>
    now.active?.batchId === batch.id ? { ...now, active: marked } : now,
  );
  return marked;
});

/**
 * The Lane DO's record of a step that threw: kept with the batch's marked
 * attempt, so the step that finds the attempt failed cites what threw.
 */
export const laneStepFailed = Effect.fn("integration/laneStepFailed")(function* (
  laneId: string,
  error: string,
) {
  const lane = laneOf(yield* EntityStore, laneId);
  const batchId = lane?.active?.batchId;
  if (lane === undefined || batchId === undefined || lane.active?.attempt === undefined) return;
  yield* noteLane(lane, `step-failed:${batchId}`, (now) =>
    now.active?.batchId !== batchId || now.active.attempt === undefined
      ? now
      : {
          ...now,
          active: {
            ...now.active,
            attempt: { ...now.active.attempt, error: error.slice(0, STEP_ERROR_MAX) },
          },
        },
  );
});

/**
 * Where a lane stands after a step: nothing to do, waiting on a verdict,
 * trunk, or the domain, or going on in a new invocation: `staged` after it
 * formed a batch or assembled its candidate, so what that stage committed is
 * published before the next one, which may take minutes, and each stage has
 * an invocation of its own; `again` after it failed a batch on the
 * infrastructure, so no one invocation tries two batches that may kill it.
 */
export type LaneStep = "idle" | "waiting" | "staged" | "again";

/**
 * Cancels the batch `from` behind the batch in flight and every batch behind
 * it, last first: each is invalidated (`cancelled`, `because` the batch whose
 * failure undid them), which sends its members back to the queue through
 * their Change DOs, and a KeelVerify instance started for it is stopped.
 * Nothing is blamed on any member: each forms again on trunk's head.
 */
const cancelBehind = Effect.fn("integration/cancelBehind")(function* (
  laneId: string,
  from: BatchId,
  because: BatchId,
  why: string,
) {
  const lane = laneOf(yield* EntityStore, laneId);
  const behind = lane?.behind ?? [];
  const at = behind.findIndex((slot) => slot.batchId === from);
  if (at === -1) return;
  const outbox = yield* EventOutbox;
  const cancelled = behind.slice(at);
  for (const slot of cancelled.toReversed()) {
    yield* onBatch(laneId, slot.batchId, `cancel:${slot.batchId}`, (batch, now) => ({
      moves: isCandidateTerminal(batch)
        ? []
        : [{ command: { _tag: "Cancel", candidateId: slot.candidateId, because } }],
      lane: () => ({
        ...now,
        behind: (now.behind ?? []).filter((each) => each.batchId !== slot.batchId),
        chainEpoch: (now.chainEpoch ?? 0) + 1,
        // A batch that failed behind on its own forms no more there: it waits to be in flight.
        ...(because === from && now.active !== undefined ? { heldBehind: now.active.batchId } : {}),
      }),
    })).pipe(Effect.orDie);
    if (slot.started === true)
      yield* (yield* BatchVerification).stop(
        instanceOf(laneId, formedOf(outbox, slot.batchId).eventId),
      );
  }
  yield* Effect.logInfo(
    `lane ${laneId}: cancelled ${cancelled.map((slot) => slot.batchId).join(", ")} behind ${because}: ${why}`,
  );
});

/**
 * One move of the speculation chain behind the batch in flight, while it
 * verifies: the first batch behind that has a stage to run runs it (compose
 * on the candidate ahead, bundle, start KeelVerify), and once each has
 * started, another batch forms behind the last, on its candidate, while the
 * queue holds changes. A step that fails, or a batch already settled, cancels
 * that batch and every batch behind it. A project whose verification is off
 * speculates nothing: it has nothing to wait for. True when something moved.
 */
const stepBehind = Effect.fn("integration/stepBehind")(function* (laneId: string) {
  const store = yield* EntityStore;
  const lane = laneOf(store, laneId);
  const active = lane?.active;
  if (lane === undefined || active === undefined) return false;
  const settings = yield* (yield* Projects).settings(lane.projectId).pipe(Effect.orDie);
  if (settings.verification === "off") return false;
  for (const slot of lane.behind ?? []) {
    const batch = batchOf(store, slot.batchId);
    if (batch === undefined || isCandidateTerminal(batch)) {
      yield* cancelBehind(laneId, slot.batchId, slot.on ?? slot.batchId, "its batch was settled");
      return true;
    }
    const ran =
      batch.state === "forming"
        ? yield* Effect.exit(composeBatch(lane, slot, batch))
        : batch.state === "assembled" && slot.bundle === undefined && slot.composed !== undefined
          ? yield* Effect.exit(bundleBatch(lane, slot, batch, slot.composed))
          : slot.bundle !== undefined &&
              (batch.state === "assembled" ||
                (batch.state === "verifying" && slot.started !== true))
            ? yield* Effect.exit(verifyBatch(lane, slot, batch, slot.bundle))
            : undefined;
    if (ran === undefined) continue;
    if (Exit.isFailure(ran))
      yield* cancelBehind(
        laneId,
        slot.batchId,
        slot.batchId,
        `its step failed: ${Cause.pretty(ran.cause).slice(0, STEP_ERROR_MAX)}`,
      );
    return true;
  }
  const tail = (lane.behind ?? []).at(-1) ?? active;
  if (tail.composed === undefined || lane.queue.length === 0) return false;
  if (lane.heldBehind === active.batchId) return false;
  if (waitsAt(lane, yield* (yield* Clock).now) !== undefined) return false;
  // Depth is chosen, not capped: another batch while a box is free to verify it.
  if ((yield* (yield* BatchVerification).capacity()).free <= 0) return false;
  yield* formBatch(lane, tail);
  return (laneOf(yield* EntityStore, laneId)?.behind?.length ?? 0) > (lane.behind?.length ?? 0);
});

/**
 * Drives the lane as far as it can go without a reply from outside: follow
 * trunk, then Form → Compose → Bundle → Verify for the one batch in flight,
 * and one look at a verification that has outrun its budget. A batch formed
 * and a candidate assembled end the step (`staged`). Every step
 * reads its I/O first and commits after, so a retry resumes where the last
 * commit left the lane. Each compose, bundle and start is marked before it
 * runs (`attempt`), so one that throws or dies is counted against its batch.
 */
export const laneStep = Effect.fn("integration/laneStep")(function* (laneId: string) {
  for (;;) {
    const store = yield* EntityStore;
    const lane = laneOf(store, laneId);
    if (lane === undefined) return "idle" satisfies LaneStep;
    const [advance] = lane.advances;
    if (advance !== undefined) {
      yield* followTrunk(lane, advance);
      continue;
    }
    const active = lane.active;
    if (active?.declined === true) {
      yield* invalidateBatch(lane, active.batchId);
      continue;
    }
    const kept = active?.kept;
    if (active !== undefined && kept !== undefined) {
      // In flight now, the verdict it was given behind is recorded as any other.
      yield* noteLane(lane, `unkept:${active.batchId}`, (now) =>
        withSlot(now, active.batchId, ({ kept: _kept, ...slot }) => slot),
      );
      yield* recordVerdict(laneId, kept).pipe(
        Effect.catchTags({ ResultFenced: () => Effect.void, CandidateNotFound: () => Effect.void }),
      );
      continue;
    }
    const [first] = lane.behind ?? [];
    if (active === undefined && first !== undefined) {
      // What was built on a batch that did not land is given up, and its members queued again.
      yield* cancelBehind(
        laneId,
        first.batchId,
        first.on ?? first.batchId,
        "the batch ahead did not land",
      );
      continue;
    }
    if (active === undefined) {
      if (lane.queue.length === 0) return "idle" satisfies LaneStep;
      // The namespace's container-minutes are spent, or its gate has no box: the lane's own deadline steps it then.
      if (waitsAt(lane, yield* (yield* Clock).now) !== undefined)
        return "waiting" satisfies LaneStep;
      yield* formBatch(lane);
      if (laneOf(yield* EntityStore, laneId)?.active !== undefined)
        return "staged" satisfies LaneStep;
      continue;
    }
    const batch = batchOf(store, active.batchId);
    if (batch === undefined)
      return yield* Effect.die(new Error(`lane ${laneId} lost batch ${active.batchId}`));
    if (isCandidateTerminal(batch)) {
      // Every terminal commit clears the batch in flight; one left behind must not stall the lane.
      yield* noteLane(lane, `cleared:${batch.id}`, (now) => ({ ...now, active: undefined }));
      continue;
    }
    if (batch.state === "forming") {
      const tried = yield* attempt(lane, active, batch, "compose");
      if (tried === undefined) return "again" satisfies LaneStep;
      yield* composeBatch(lane, tried, batch);
      if (batchOf(yield* EntityStore, batch.id)?.state === "assembled")
        return "staged" satisfies LaneStep;
      continue;
    }
    if (batch.state === "assembled" && active.bundle === undefined) {
      if (active.composed === undefined)
        return yield* Effect.die(new Error(`batch ${batch.id} assembled with no candidate`));
      const tried = yield* attempt(lane, active, batch, "bundle");
      if (tried === undefined) return "again" satisfies LaneStep;
      const settings = yield* (yield* Projects).settings(lane.projectId).pipe(Effect.orDie);
      if (settings.verification === "off") yield* passUnverified(lane, tried, batch);
      else yield* bundleBatch(lane, tried, batch, active.composed);
      continue;
    }
    if (
      active.bundle !== undefined &&
      (batch.state === "assembled" || (batch.state === "verifying" && active.started !== true))
    ) {
      const tried = yield* attempt(lane, active, batch, "start");
      if (tried === undefined) return "again" satisfies LaneStep;
      yield* verifyBatch(lane, tried, batch, active.bundle);
      continue;
    }
    // A verification past its budget gets one look, which settles it: the step then goes on.
    const due = verifying(store, yield* EventOutbox, laneId)?.due;
    if (due !== undefined && (yield* (yield* Clock).now) >= due)
      if ((yield* checkVerification(laneId)) !== "running") continue;
    if (yield* stepBehind(laneId)) return "staged" satisfies LaneStep;
    return "waiting" satisfies LaneStep;
  }
});

/** A bounce is on the member `attribute` pins; a batch of one's failure is its member's. */
const blameOf = (batch: Batch, failingTests: readonly string[]): BatchAttribution => {
  const [only] = batch.members;
  if (batch.members.length === 1 && only !== undefined) return only;
  const found = attribute(
    failingTests[0] ?? "",
    batch.members.map((id) => ({ id, affected: [] })),
  );
  return found.next._tag === "culprit" ? found.next.id : "unattributed";
};

/** What a verdict commits: the outcome, evidence and remedy it is issued with, who the batch is on, and the lane after. */
interface Issued {
  readonly outcome: VerdictOutcome;
  readonly evidence: readonly string[];
  readonly nextActions?: readonly NextAction[];
  /** Absent for a land. */
  readonly attribution?: BatchAttribution;
  readonly lane: Lane;
  readonly exhausted?: string;
  readonly held?: string;
}

/** What a verdict is issued from: KeelVerify's own, or the Lane's for an instance that will send none. */
type Verdict = Pick<
  BatchVerdict,
  | "verdictId"
  | "outcome"
  | "planHash"
  | "evidence"
  | "failingTests"
  | "nextActions"
  | "unrun"
  | "retryAt"
  | "halted"
  | "tests"
>;

/** A failure of the infrastructure's capacity (no box, rate-limited): the members are requeued and nothing is counted, since it says nothing about any of them. */
const uncounted = (lane: Lane): ReturnType<typeof infraBlame> => ({ attribution: "infra", lane });

/**
 * A green batch the shrink rule holds back: a step it watches passed fewer
 * tests than trunk's last verdict allows. A batch of one parks its member for
 * a maintainer's ruling on the drop, asked for this verdict, and the lane
 * keeps the drop it asked about; in an agent's own namespace, where no person
 * can rule (`rulable` false), it bounces its member instead, saying so. A
 * batch of several is bisected, so the question is asked of the change that
 * dropped them. None of these counts as a pass or a fail.
 */
const shrinkIssued = (
  verdict: Verdict,
  batch: Batch,
  lane: Lane,
  shrunk: readonly Shrunk[],
  rulable: boolean,
): Issued => {
  const evidence = [
    ...verdict.evidence,
    ...shrunk.map(
      (s) =>
        `shrink rule: ${shrinkLine(s)}${s.allowed < s.trunk ? `, more than the ${s.trunk - s.allowed} a maintainer accepted` : ""}`,
    ),
  ];
  const [sole, ...others] = batch.members;
  if (sole === undefined || others.length > 0)
    return { outcome: "park", evidence, attribution: "unattributed", lane };
  if (!rulable)
    return {
      outcome: "bounce",
      evidence,
      nextActions: [
        {
          kind: "call",
          title:
            "Restore the tests this change drops, then submit again: no person can accept a drop in tests in an agent's own namespace (its project's .keel/flow.json may turn the shrink rule off)",
          operationId: "submit",
          args: { changeId: sole },
        },
      ],
      attribution: sole,
      lane,
    };
  const asked = {
    changeId: sole,
    verdictId: verdict.verdictId,
    steps: shrunk.map((s) => ({ stepId: s.stepId, fewer: s.trunk - s.passed })),
  };
  return {
    outcome: "park",
    evidence,
    attribution: "shrink",
    lane: { ...lane, drops: [...(withoutDrops(lane, [sole]).drops ?? []), asked] },
  };
};

const issuedFor = (
  verdict: Verdict,
  batch: Batch,
  lane: Lane,
  at: number,
  rulable = true,
): Issued => {
  const cleared = withoutInfra(lane, batch.members);
  if (verdict.outcome === "land") {
    const shrunk = shrunkSteps(lane, batch.members, verdict.tests ?? []);
    if (shrunk.length > 0) return shrinkIssued(verdict, batch, cleared, shrunk, rulable);
    const counted = verdict.tests ?? [];
    const passed = withOutcomes(
      cleared,
      batch.members.map(() => "pass" as const),
    );
    return {
      outcome: "land",
      evidence: verdict.evidence,
      // What it counted becomes trunk's last verdict once trunk takes the batch.
      lane:
        counted.length === 0
          ? passed
          : withSlot(passed, batch.id, (slot) => ({ ...slot, landing: counted })),
    };
  }
  // KeelVerify's own remedy (what to fix in the failing tests) when it gave one.
  const verifiersRemedy =
    verdict.nextActions === undefined || verdict.nextActions.length === 0
      ? {}
      : { nextActions: verdict.nextActions };
  // Halted: every member bounces with what its owner does, and none is blamed, counted or run alone.
  if (verdict.outcome === "bounce" && verdict.halted === true)
    return {
      outcome: "bounce",
      evidence: verdict.evidence,
      ...verifiersRemedy,
      attribution: "halted",
      lane: cleared,
    };
  if (verdict.outcome === "bounce") {
    const attribution = blameOf(batch, verdict.failingTests);
    return {
      outcome: "bounce",
      evidence: verdict.evidence,
      ...verifiersRemedy,
      attribution,
      // A member blamed is a failure the batch size reads; one not yet found is counted when it is.
      lane: batch.members.some((member) => member === attribution)
        ? withOutcomes(cleared, ["fail"])
        : cleared,
    };
  }
  // park, hold and supersede are the infrastructure's, never a member's: until the limit in a row, unless no step could run.
  // A park for want of quota says when there is room again: nothing forms before then.
  const infra =
    verdict.outcome === "park" && verdict.unrun === true
      ? uncounted(verdict.retryAt === undefined ? lane : { ...lane, notBefore: verdict.retryAt })
      : infraBlame(lane, batch, `${verdict.outcome}: ${verdict.evidence[0] ?? "no evidence"}`, at);
  return infra.exhausted === undefined
    ? {
        outcome: verdict.outcome,
        evidence: verdict.evidence,
        ...verifiersRemedy,
        attribution: "infra",
        lane: infra.lane,
        ...(infra.held === undefined ? {} : { held: infra.held }),
      }
    : {
        outcome: "bounce",
        evidence: [infra.exhausted, ...verdict.evidence],
        nextActions: afterInfra(batch, INFRA_FAILURE_LIMIT),
        attribution: infra.attribution,
        lane: infra.lane,
        exhausted: infra.exhausted,
      };
};

/**
 * Commits a verdict on the verifying batch: VerdictIssued, then BatchVerified
 * (a land) or BatchFailed, in one transaction through the Candidate machine,
 * fenced on the batch's attempt and chain epoch. The third consecutive infra
 * failure of a change bounces it, and is logged at error level.
 */
const issue = Effect.fn("integration/issue")(function* (
  laneId: string,
  batch: Batch,
  cause: string,
  verdict: Verdict,
  fence: { readonly attempt: number; readonly chainEpoch: number },
) {
  // A batch of one that dropped tests is put to a maintainer before its verdict parks it: raising it twice asks nobody twice.
  const [sole, ...others] = batch.members;
  const before = laneOf(yield* EntityStore, laneId);
  const [shrank, ...shranks] =
    verdict.outcome === "land" && before !== undefined
      ? shrunkSteps(before, batch.members, verdict.tests ?? [])
      : [];
  const asking =
    shrank !== undefined && sole !== undefined && others.length === 0 && before !== undefined;
  const namespace = asking
    ? yield* projectNamespace(before.projectId).pipe(Effect.orDie)
    : undefined;
  // An agent's own namespace has no person to ask: the drop goes back to the agent.
  const rulable = namespace === undefined || namespaceKind(namespace) !== "agent";
  if (asking && namespace !== undefined && rulable)
    yield* askShrinkRuling({
      namespace,
      project: before.projectId,
      changeId: sole,
      verdictId: verdict.verdictId,
      steps: [shrank, ...shranks],
    }).pipe(Effect.orDie);
  // Set inside the transaction when this verdict is the change's last infra failure allowed.
  let exhausted: string | undefined;
  let held: string | undefined;
  // A failure of several that no one is blamed for splits into batches of one, minted here: each member runs alone.
  const ids = yield* Ids;
  const into =
    batch.members.length > 1 ? yield* Effect.forEach(batch.members, () => ids.next("bat")) : [];
  const committed = yield* onBatch(laneId, batch.id, cause, (now, lane, at) => {
    const issued = issuedFor(verdict, now, lane, at, rulable);
    exhausted = issued.exhausted;
    held = issued.held;
    const bisected = issued.attribution === "unattributed";
    return {
      moves: [
        {
          command:
            issued.attribution === undefined
              ? { _tag: "Verified", verdictId: verdict.verdictId, ...fence }
              : {
                  _tag: "Failed",
                  verdictId: verdict.verdictId,
                  attribution: issued.attribution,
                  ...fence,
                },
          before: [
            verdictDraft(
              VerdictIssued.make({
                verdictId: verdict.verdictId,
                subject: now.id,
                outcome: issued.outcome,
                evidence: issued.evidence,
                planHash: verdict.planHash,
                ...(issued.nextActions === undefined ? {} : { nextActions: issued.nextActions }),
              }),
              now.members,
            ),
          ],
        },
        ...(bisected ? [{ command: { _tag: "Bisect", into } } satisfies Move] : []),
      ],
      lane: (after) => {
        if (after.state !== "red" && after.state !== "bisected") return issued.lane;
        const settled: Lane = { ...issued.lane, active: undefined };
        if (!bisected) return settled;
        // Each member forms its next batch alone, under the id CandidateBisected named for it.
        const split = withoutAlone(settled, now.members);
        const named = now.members.flatMap((changeId, i) => {
          const batchId = into[i];
          return batchId === undefined ? [] : [{ changeId, batchId }];
        });
        return { ...split, alone: [...(split.alone ?? []), ...named] };
      },
    };
  });
  if (!committed.duplicate && exhausted !== undefined)
    yield* Effect.logError(`lane ${laneId} bounced ${batch.members.join(", ")} on ${exhausted}`);
  if (!committed.duplicate && held !== undefined) yield* Effect.logError(`lane ${laneId}: ${held}`);
  return committed;
});

/**
 * KeelVerify's verdict on the batch in flight, fenced on `(batchId, attempt,
 * chainEpoch)`. Idempotent by the instance (cause
 * `<instanceId>:recordVerdict`). A result for another attempt or epoch is
 * ResultFenced, which is terminal, and so is one for a batch the Lane has
 * already settled (its instance was given up on at its budget, and the
 * verdict came after). A destroyed lane holds no candidate: its verdict is
 * CandidateNotFound.
 */
export const recordVerdict = Effect.fn("integration/recordVerdict")(function* (
  laneId: string,
  verdict: BatchVerdict,
) {
  const store = yield* EntityStore;
  const found = laneDestroyed(store, laneId) ? undefined : batchOf(store, verdict.fence.batchId);
  const batch =
    found !== undefined && found.candidateId === verdict.candidateId
      ? found
      : yield* new CandidateNotFound({ candidateId: verdict.candidateId });
  const fence = { attempt: verdict.fence.attempt, chainEpoch: verdict.fence.chainEpoch };
  const lane = laneOf(store, laneId);
  if (lane !== undefined && isBehind(lane, batch.id)) {
    if (fence.attempt !== batch.attempt || fence.chainEpoch !== batch.chainEpoch)
      return yield* new ResultFenced({ batchId: batch.id, ...fence });
    // Kept until every batch ahead has landed: trunk is only ever offered the batch in flight.
    return yield* noteLane(lane, `${verdict.instanceId}:keep`, (now) =>
      withSlot(now, batch.id, (slot) => ({ ...slot, kept: verdict })),
    ).pipe(Effect.asVoid);
  }
  return yield* issue(laneId, batch, `${verdict.instanceId}:recordVerdict`, verdict, fence).pipe(
    Effect.asVoid,
    Effect.catchTags({
      CandidateStateRefused: (refused) => {
        const now = batchOf(store, batch.id);
        return now !== undefined && isCandidateTerminal(now)
          ? Effect.fail(new ResultFenced({ batchId: batch.id, ...fence }))
          : Effect.die(refused);
      },
      InvalidBatch: (invalid) => Effect.die(invalid),
    }),
  );
});

/**
 * KeelVerify's report of one step of the batch it verifies, committed through
 * the Candidate machine as VerificationStepStarted or VerificationStepFinished,
 * fenced on `(batchId, attempt, chainEpoch)`. Idempotent by the instance, the
 * step, its world and which of the two it is. A step for a batch no longer
 * verifying (its verdict in, cancelled, settled at its budget), or for another
 * attempt or epoch, is ResultFenced; one for a candidate the lane does not
 * hold is CandidateNotFound. The lane's queue is untouched either way.
 */
export const recordStep = Effect.fn("integration/recordStep")(function* (
  laneId: string,
  reported: BatchStepReport,
) {
  const store = yield* EntityStore;
  const found = laneDestroyed(store, laneId) ? undefined : batchOf(store, reported.fence.batchId);
  const batch =
    found !== undefined && found.candidateId === reported.candidateId
      ? found
      : yield* new CandidateNotFound({ candidateId: reported.candidateId });
  const fence = { attempt: reported.fence.attempt, chainEpoch: reported.fence.chainEpoch };
  const { step } = reported;
  const phase = step._tag === "Started" ? "started" : "finished";
  yield* onBatch(
    laneId,
    batch.id,
    `${reported.instanceId}:step:${phase}:${step.stepId}@${step.world ?? ""}`,
    (_, lane) => ({
      moves: [{ command: { _tag: "RecordStep", step, ...fence } }],
      lane: () => lane,
    }),
  ).pipe(
    Effect.catchTags({
      CandidateStateRefused: () => Effect.fail(new ResultFenced({ batchId: batch.id, ...fence })),
      InvalidBatch: (invalid) => Effect.die(invalid),
    }),
  );
});

/**
 * How long a KeelVerify instance has to send its verdict. Past it the Lane
 * ends the instance and fails its batch on the infrastructure, so one
 * instance that never answers cannot hold the lane.
 */
export const VERIFY_BUDGET_MS = 900_000;

/** The batch in flight while it verifies, with its KeelVerify instance and when its budget runs out. */
const verifying = (store: Store, outbox: (typeof EventOutbox)["Service"], laneId: string) => {
  const lane = laneOf(store, laneId);
  const active = lane?.active;
  const batch = active === undefined ? undefined : batchOf(store, active.batchId);
  if (active === undefined || batch?.state !== "verifying") return undefined;
  const started = startedOf(outbox, batch.id);
  return started === undefined
    ? undefined
    : { active, batch, instanceId: started.instanceId, due: started.at + VERIFY_BUDGET_MS };
};

/**
 * When the verifying batch's instance runs out of its budget, or undefined
 * when no batch is verifying. It is derived from the batch's own
 * VerificationStarted, so arming it again after every step never postpones
 * it.
 */
export const verificationDue = Effect.fn("integration/verificationDue")(function* (laneId: string) {
  return verifying(yield* EntityStore, yield* EventOutbox, laneId)?.due;
});

/** What a look at the verifying batch's instance came to. */
export type VerificationCheck =
  /** No batch is verifying, or the report named another instance than the batch in flight's. */
  | "idle"
  /** The instance may still send its verdict: nothing is settled. */
  | "running"
  /** The instance will send none: its batch is failed on the infrastructure. */
  | "settled";

/**
 * Looks once at the KeelVerify instance of the batch in flight, and settles
 * the batch when no verdict can come from it. `reported` is the instance a
 * platform event named: a hint, so only the batch in flight's own instance
 * is looked at, and only what the read says is acted on. An instance that
 * Failed (in error, terminated, never made) is settled whenever it is seen.
 * At the budget's end one that completed with its batch still verifying is
 * settled too, and one still running is stopped first, so its verdict cannot
 * arrive after.
 *
 * Settling is KeelVerify's `park`, issued by the Lane: BatchFailed `infra`
 * requeues the change to be verified afresh by a new instance, and the third
 * such failure of one change in a row bounces it with its next actions. A
 * verdict that got there first leaves nothing to settle.
 */
export const checkVerification = Effect.fn("integration/checkVerification")(function* (
  laneId: string,
  reported?: string,
) {
  const found = verifying(yield* EntityStore, yield* EventOutbox, laneId);
  if (found === undefined || (reported !== undefined && reported !== found.instanceId))
    return "idle" satisfies VerificationCheck;
  const { active, batch, instanceId } = found;
  const verification = yield* BatchVerification;
  const standing = yield* verification.standing(instanceId);
  const overdue = (yield* (yield* Clock).now) >= found.due;
  if (standing._tag !== "Failed" && !overdue) return "running" satisfies VerificationCheck;
  if (standing._tag === "Running") yield* verification.stop(instanceId);
  const why =
    standing._tag === "Failed"
      ? `${standing.status}${standing.error === undefined ? "" : `: ${standing.error}`}`
      : standing._tag === "Running"
        ? `still running after ${VERIFY_BUDGET_MS / 60_000} minutes, and was stopped`
        : "completed without recording a verdict";
  const settled = yield* issue(
    laneId,
    batch,
    `${instanceId}:instance-failed`,
    {
      verdictId: yield* (yield* Ids).next("vrd"),
      outcome: "park",
      planHash: yield* plannedOf(active),
      evidence: [`verification-failed: instance ${instanceId} ${why}`],
      failingTests: [],
    },
    { attempt: batch.attempt, chainEpoch: batch.chainEpoch },
  ).pipe(
    Effect.as("settled" as const),
    Effect.catchTags({
      // A verdict was recorded while this looked: the batch is no longer verifying.
      CandidateStateRefused: () => Effect.succeed("idle" as const),
      ResultFenced: (fenced) => Effect.die(fenced),
      InvalidBatch: (invalid) => Effect.die(invalid),
    }),
  );
  return settled satisfies VerificationCheck;
});

/**
 * The platform reported that a KeelVerify instance ended without completing:
 * its lane, read from the instance's id, is told. An id that names no lane
 * (another Workflow's, or one started before ids carried their lane) is
 * dropped: the lane's own deadline settles such an instance.
 */
export const instanceEnded = Effect.fn("integration/instanceEnded")(function* (instanceId: string) {
  const laneId = laneOfInstance(instanceId);
  if (laneId === undefined) return "dropped" as const;
  yield* (yield* Lanes).verificationEnded(laneId, instanceId);
  return "told" as const;
});
