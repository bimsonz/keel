import { Effect, Result, Schema } from "effect";
import {
  ChangeBounced,
  ChangeParked,
  ChangeQueued,
  ChangeRequeued,
  ChangeResumed,
  ChangeSuperseded,
  ChangeWithdrawn,
} from "../../domain/coordination/index.ts";
import {
  attribute,
  Batch,
  type BatchAttribution,
  CandidateEvent,
  type CandidateCommand,
  CandidateNotFound,
  type CandidateRejection,
  type CompositionRefused,
  decideCandidate,
  evolveCandidate,
  isCandidateTerminal,
  PromotionDeclined,
  ResultFenced,
  TrunkAdvanced,
  VerificationStarted,
} from "../../domain/integration/index.ts";
import {
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  ContentHash,
  type EntityRef,
  type EventEnvelope,
  type Instant,
  type NextAction,
  ProjectId,
} from "../../domain/kernel/index.ts";
import { type VerdictOutcome, VerdictIssued } from "../../domain/verification/index.ts";
import {
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
  Projects,
  REDELIVERY_CAP_MS,
  type RepoRef,
  StagingWriter,
  type Transaction,
  type Transition,
} from "../ports/index.ts";
import { projectNamespace } from "../verification/index.ts";
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

/** On this many consecutive infra failures of one change the Lane bounces it, so it never loops. */
export const INFRA_FAILURE_LIMIT = 3;

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
  /** The green batch's BatchVerified re-offered to trunk so far, and when the last went (epoch ms). */
  reoffered: Schema.optional(Schema.Struct({ count: Schema.Int, at: Schema.Number })),
});
type ActiveBatch = typeof ActiveBatch.Type;

/** A lane: its FIFO queue, the one batch in flight at L1, trunk advances staging has yet to follow. */
export const Lane = Schema.Struct({
  laneId: Schema.String,
  projectId: ProjectId,
  queue: Schema.Array(ChangeId),
  /** Each queued change's compiled plan, from the ChangeQueued or ChangeRequeued that queued it. */
  plans: Schema.optional(
    Schema.Array(Schema.Struct({ changeId: ChangeId, planHash: ContentHash })),
  ),
  active: Schema.optional(ActiveBatch),
  advances: Schema.Array(
    Schema.Struct({ from: CommitSha, to: CommitSha, members: Schema.Array(ChangeId) }),
  ),
  /** Each change's consecutive infra failures, their reasons oldest first. */
  infra: Schema.Array(Schema.Struct({ changeId: ChangeId, reasons: Schema.Array(Schema.String) })),
  /** Trunk's head as the last TrunkAdvanced heard named it: no batch forms on a staging main anywhere else. */
  trunkHead: Schema.optional(CommitSha),
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

/** A lane is addressed `lane:<projectId>:<name>`; the L1 lane of a project is `lane:<projectId>:main`. */
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
  (lane.active !== undefined &&
    (batchOf(store, lane.active.batchId)?.members.includes(changeId) ?? false));

const decodeQueued = Schema.decodeUnknownSync(ChangeQueued);
const decodeRequeued = Schema.decodeUnknownSync(ChangeRequeued);
const decodeParked = Schema.decodeUnknownSync(ChangeParked);
const decodeResumed = Schema.decodeUnknownSync(ChangeResumed);
const decodeAdvanced = Schema.decodeUnknownSync(TrunkAdvanced);
const decodeDeclined = Schema.decodeUnknownSync(PromotionDeclined);
const decodeStarted = Schema.decodeUnknownSync(VerificationStarted);
const decodeEnded = Schema.decodeUnknownSync(
  Schema.Union([ChangeWithdrawn, ChangeSuperseded, ChangeBounced]),
);

/**
 * A delivered event, inside the transaction that records it: ChangeQueued
 * joins the queue's back, ChangeRequeued its front (it re-enters with no
 * blame), each keeping the plan hash its event names, a change parked for a
 * person's ruling while queued leaves the queue with its plan kept and
 * rejoins at the front when it is resumed, a change withdrawn,
 * superseded or bounced while queued leaves the queue (one in the batch in
 * flight finishes its batch),
 * TrunkAdvanced is noted for staging to follow and names trunk's head, and a
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
        return queued.laneId !== laneId || holds(tx.store, lane, queued.changeId)
          ? undefined
          : withPlan(
              { ...lane, queue: [...lane.queue, queued.changeId] },
              queued.changeId,
              queued.planHash,
            );
      }
      case "ChangeRequeued": {
        const requeued = decodeRequeued(event.payload);
        return holds(tx.store, lane, requeued.changeId)
          ? undefined
          : withPlan(
              { ...lane, queue: [requeued.changeId, ...lane.queue] },
              requeued.changeId,
              requeued.planHash,
            );
      }
      case "ChangeParked": {
        // Held for a person's ruling: out of the queue, its plan kept for when it resumes.
        const parked = decodeParked(event.payload);
        return parked.reason === "awaiting-ruling" && lane.queue.includes(parked.changeId)
          ? { ...lane, queue: lane.queue.filter((id) => id !== parked.changeId) }
          : undefined;
      }
      case "ChangeResumed": {
        // Back to the front, with the plan it was queued under: it waited for a person, not for its turn.
        const { changeId } = decodeResumed(event.payload);
        const queuedHere = (lane.plans ?? []).some((plan) => plan.changeId === changeId);
        return queuedHere && !holds(tx.store, lane, changeId)
          ? { ...lane, queue: [changeId, ...lane.queue] }
          : undefined;
      }
      case "ChangeWithdrawn":
      case "ChangeSuperseded":
      case "ChangeBounced": {
        const ended = decodeEnded(event.payload);
        // One held for a ruling is in no queue, and its kept plan goes with it.
        const kept = (lane.plans ?? []).some((plan) => plan.changeId === ended.changeId);
        return lane.queue.includes(ended.changeId) ||
          (kept && !holds(tx.store, lane, ended.changeId))
          ? withPlan(
              { ...lane, queue: lane.queue.filter((id) => id !== ended.changeId) },
              ended.changeId,
              undefined,
            )
          : undefined;
      }
      case "TrunkAdvanced": {
        const advanced = decodeAdvanced(event.payload);
        return advanced.projectId !== lane.projectId
          ? undefined
          : {
              ...lane,
              advances: [
                ...lane.advances,
                {
                  from: advanced.from,
                  to: advanced.to,
                  members: advanced.landings.map((landing) => landing.changeId),
                },
              ],
              trunkHead: advanced.to,
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
  plan: (batch: Batch, lane: Lane) => BatchStep,
) =>
  commit({ entity: batchRef(batchId), cause, project: laneProject(laneId) }, (tx) => {
    const batch = batchOf(tx.store, batchId);
    const lane = laneOf(tx.store, laneId);
    if (batch === undefined || lane === undefined)
      throw new Error(`lane ${laneId} holds no batch ${batchId}`);
    const step = plan(batch, lane);
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
 * An infrastructure failure of the batch, blamed on `infra` (the Change DO
 * requeues its members) until a batch of one fails that way the
 * INFRA_FAILURE_LIMIT-th time in a row: then on the change, so it bounces
 * visibly, with every reason, instead of looping.
 */
const infraBlame = (
  lane: Lane,
  batch: Batch,
  reason: string,
): {
  readonly attribution: ChangeId | "infra";
  readonly lane: Lane;
  readonly exhausted?: string;
} => {
  const [only] = batch.members;
  const sole = batch.members.length === 1 ? only : undefined;
  if (sole === undefined) return { attribution: "infra", lane };
  const reasons = [...(lane.infra.find((entry) => entry.changeId === sole)?.reasons ?? []), reason];
  const others = withoutInfra(lane, [sole]);
  if (reasons.length >= INFRA_FAILURE_LIMIT)
    return {
      attribution: sole,
      lane: others,
      exhausted: `infra-failure x${reasons.length}: ${reasons.join("; ")}`,
    };
  return {
    attribution: "infra",
    lane: { ...others, infra: [...others.infra, { changeId: sole, reasons }] },
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
const stagingOnTrunk = (lane: Lane) =>
  Effect.gen(function* () {
    const staging = projectRepos(lane.projectId).staging;
    const head = yield* (yield* CodeHost).head(staging, MAIN).pipe(Effect.orDie);
    const trunk = lane.trunkHead;
    if (trunk === undefined || head === trunk) return head;
    const moved = yield* Effect.result((yield* StagingWriter).fastForward(head, trunk));
    if (Result.isFailure(moved))
      return yield* Effect.die(
        new Error(
          `lane ${lane.laneId} forms nothing: staging is at ${head}, trunk at ${trunk}, and the move failed (${moved.failure._tag})`,
        ),
      );
    return trunk;
  });

/** Forms a batch of one from the queue's head, on staging main's head, which is trunk's. */
const formBatch = Effect.fn("integration/formBatch")(function* (lane: Lane) {
  const base = yield* stagingOnTrunk(lane);
  const ids = yield* Ids;
  const batchId = yield* ids.next("bat");
  const candidateId = yield* ids.next("cnd");
  yield* commit(
    { entity: batchRef(batchId), cause: `form:${batchId}`, project: lane.projectId },
    (tx): Result.Result<Transition<undefined>, CandidateRejection> => {
      const now = laneOf(tx.store, lane.laneId) ?? lane;
      const [first] = now.queue;
      if (first === undefined || now.active !== undefined)
        return Result.succeed({ value: undefined, drafts: [] });
      const members = [first];
      return Result.map(
        decideCandidate(
          undefined,
          {
            _tag: "Form",
            laneId: lane.laneId,
            projectId: lane.projectId,
            members,
            base,
            predecessors: [],
            attempt: 0,
            chainEpoch: 0,
          },
          { now: tx.at, batchId },
        ),
        (events) => {
          // Subscribed before the append, so BatchFormed itself reaches them.
          for (const member of members)
            tx.outbox.subscribe(`change:${member}`, MEMBER_EVENTS, changeRef(member));
          tx.outbox.subscribe(`trunk:${lane.projectId}`, ["BatchVerified"]);
          tx.store.put(BATCH, batchId, encodeBatch(fold(undefined, events, tx.at)));
          const planHash = planOf(now, first);
          putLane(tx.store, {
            ...withPlan(now, first, undefined),
            queue: now.queue.slice(1),
            active: { batchId, candidateId, ...(planHash === undefined ? {} : { planHash }) },
          });
          return { value: undefined, drafts: events.map((e) => batchDraft(e, members)) };
        },
      );
    },
  ).pipe(Effect.orDie);
});

/** A composition GitCore refused: the verdict, then BatchFailed (on the change of a batch of one), in one transaction. */
const refuseComposition = Effect.fn("integration/refuseComposition")(function* (
  lane: Lane,
  batch: Batch,
  refused: CompositionRefused,
) {
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
                `composition-refused: ${refused.reason} ${refused.paths.join(" ")}`.trimEnd(),
              ],
              // Trunk moved under the change: rebase puts trunk's head on the workspace's keel/trunk, and the agent merges it (never a force push).
              nextActions: [
                remedy(
                  batch,
                  "rebase",
                  `Rebase the change onto trunk's head (it was ${batch.base} at this bounce): Keel puts it on your workspace's keel/trunk branch`,
                ),
                remedy(
                  batch,
                  "submit",
                  `Then run git fetch origin keel/trunk && git merge FETCH_HEAD, resolve ${refused.paths.join(", ") || "the conflict"}, push, and submit again`,
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

/** Composes the batch onto its base in staging, one restacked commit per member; a batch with no plan is refused first. */
const composeBatch = Effect.fn("integration/composeBatch")(function* (
  lane: Lane,
  active: ActiveBatch,
  batch: Batch,
) {
  if (active.planHash === undefined) {
    yield* refusePlanless(lane, batch);
    return;
  }
  const changes = yield* Changes;
  const members = yield* Effect.forEach(batch.members, (changeId) =>
    Effect.gen(function* () {
      const { change } = yield* changes.get(changeId);
      const workspace = yield* changes.workspace(changeId);
      if (change.commitSha === undefined)
        return yield* Effect.die(new Error(`${changeId} is in a batch with no submitted commit`));
      return {
        changeId,
        repo: workspace.repo,
        base: workspace.baseSha,
        head: change.commitSha,
        title: change.intent.goal,
        // The agent the change belongs to, as the gate authenticated it: never what its commit says.
        agent: { id: change.agentId },
      } satisfies CandidateMember;
    }).pipe(Effect.orDie),
  );
  const formed = formedOf(yield* EventOutbox, batch.id);
  const composed = yield* Effect.result(
    (yield* CandidateComposer).compose({
      candidateId: active.candidateId,
      staging: projectRepos(lane.projectId).staging,
      base: batch.base,
      at: formed.at,
      members,
    }),
  );
  if (Result.isFailure(composed)) {
    yield* refuseComposition(lane, batch, composed.failure);
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
        },
      },
    ],
    lane: () => ({
      ...now,
      active: {
        ...active,
        composed: { commitSha: candidate.commitSha, commits: candidate.commits },
      },
    }),
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
    (yield* CandidateBundles).bundle(namespace, staging, composed.commitSha),
  );
  if (Result.isSuccess(bundled)) {
    yield* noteLane(lane, `bundled:${batch.id}`, (now) => ({
      ...now,
      active: { ...active, bundle: bundled.success },
    }));
    return;
  }
  const refused = bundled.failure;
  const blame =
    refused.path === undefined
      ? "infra"
      : yield* bundleBlame(staging, refused.path, batch.base, composed.commits);
  const verdictId = yield* (yield* Ids).next("vrd");
  let exhausted: string | undefined;
  yield* onBatch(lane.laneId, batch.id, `bundle-refused:${batch.id}`, (_, now) => {
    const evidence = [
      `bundle-refused: ${refused.reason}`,
      ...(blame === "infra" && refused.path !== undefined
        ? [`bundle-refused-in-base: ${refused.path}`]
        : []),
    ];
    const infra = blame === "infra" ? infraBlame(now, batch, evidence.join("; ")) : undefined;
    exhausted = infra?.exhausted;
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
  });
  yield* noteLane(lane, `verify-started:${batch.id}`, (now) =>
    now.active?.batchId === batch.id ? { ...now, active: { ...now.active, started: true } } : now,
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
    lane: () => withoutInfra(now, batch.members),
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
    yield* onBatch(lane.laneId, batch.id, `promote:${batch.id}`, (_, now) => ({
      moves: [{ command: { _tag: "Promote", trunkSha: advance.to } }],
      lane: () => ({ ...withoutInfra(now, batch.members), active: undefined }),
    })).pipe(Effect.orDie);
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

/** Where a lane stands after a step: nothing to do, or waiting on a verdict, trunk, or the domain. */
export type LaneStep = "idle" | "waiting";

/**
 * Drives the lane as far as it can go without a reply from outside: follow
 * trunk, then Form → Compose → Bundle → Verify for the one batch in flight,
 * and one look at a verification that has outrun its budget. Every step
 * reads its I/O first and commits after, so a retry resumes where the last
 * commit left the lane.
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
    if (active === undefined) {
      if (lane.queue.length === 0) return "idle" satisfies LaneStep;
      yield* formBatch(lane);
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
      yield* composeBatch(lane, active, batch);
      continue;
    }
    if (batch.state === "assembled" && active.bundle === undefined) {
      if (active.composed === undefined)
        return yield* Effect.die(new Error(`batch ${batch.id} assembled with no candidate`));
      const settings = yield* (yield* Projects).settings(lane.projectId).pipe(Effect.orDie);
      if (settings.verification === "off") yield* passUnverified(lane, active, batch);
      else yield* bundleBatch(lane, active, batch, active.composed);
      continue;
    }
    if (
      active.bundle !== undefined &&
      (batch.state === "assembled" || (batch.state === "verifying" && active.started !== true))
    ) {
      yield* verifyBatch(lane, active, batch, active.bundle);
      continue;
    }
    // A verification past its budget gets one look, which settles it: the step then goes on.
    const due = verifying(store, yield* EventOutbox, laneId)?.due;
    if (due !== undefined && (yield* (yield* Clock).now) >= due)
      if ((yield* checkVerification(laneId)) !== "running") continue;
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
}

/** What a verdict is issued from: KeelVerify's own, or the Lane's for an instance that will send none. */
type Verdict = Pick<
  BatchVerdict,
  "verdictId" | "outcome" | "planHash" | "evidence" | "failingTests" | "nextActions"
>;

const issuedFor = (verdict: Verdict, batch: Batch, lane: Lane): Issued => {
  const cleared = withoutInfra(lane, batch.members);
  if (verdict.outcome === "land")
    return { outcome: "land", evidence: verdict.evidence, lane: cleared };
  // KeelVerify's own remedy (what to fix in the failing tests) when it gave one.
  const verifiersRemedy =
    verdict.nextActions === undefined || verdict.nextActions.length === 0
      ? {}
      : { nextActions: verdict.nextActions };
  if (verdict.outcome === "bounce")
    return {
      outcome: "bounce",
      evidence: verdict.evidence,
      ...verifiersRemedy,
      attribution: blameOf(batch, verdict.failingTests),
      lane: cleared,
    };
  // park, hold and supersede are the infrastructure's, never a member's: until the limit in a row.
  const infra = infraBlame(
    lane,
    batch,
    `${verdict.outcome}: ${verdict.evidence[0] ?? "no evidence"}`,
  );
  return infra.exhausted === undefined
    ? {
        outcome: verdict.outcome,
        evidence: verdict.evidence,
        ...verifiersRemedy,
        attribution: "infra",
        lane: infra.lane,
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
  // Set inside the transaction when this verdict is the change's last infra failure allowed.
  let exhausted: string | undefined;
  const committed = yield* onBatch(laneId, batch.id, cause, (now, lane) => {
    const issued = issuedFor(verdict, now, lane);
    exhausted = issued.exhausted;
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
      ],
      lane: (after) =>
        after.state === "red" ? { ...issued.lane, active: undefined } : issued.lane,
    };
  });
  if (!committed.duplicate && exhausted !== undefined)
    yield* Effect.logError(`lane ${laneId} bounced ${batch.members.join(", ")} on ${exhausted}`);
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
  yield* issue(laneId, batch, `${verdict.instanceId}:recordVerdict`, verdict, fence).pipe(
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
