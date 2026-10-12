import { Effect, Exit, Option, Result, Schema } from "effect";
import type { PushRefusedReason } from "../../domain/coordination/index.ts";
import {
  BatchVerified,
  type CommutationFacts,
  decidePromotion,
  PromotionStateRefused,
  evolvePromotion,
  type Footprints,
  type PromotionCommand,
  pushTarget,
  type QueuedBatch,
  Trunk,
  TrunkEvent,
} from "../../domain/integration/index.ts";
import type {
  CandidateId,
  ChangeId,
  CommitSha,
  EntityRef,
  EventEnvelope,
  OrgId,
  ProjectId,
} from "../../domain/kernel/index.ts";
import {
  Clock,
  CodeHost,
  commit,
  EntityStore,
  type EventDraft,
  OrgUsage,
  ProjectOrgs,
  type Transaction,
  TrunkWriter,
} from "../ports/index.ts";
import { projectRepos } from "./project-repos.ts";

/** The EntityStore kind holding a trunk's folded state, keyed by its project. */
const TRUNK = "trunk";
/** The EntityStore kind marking a trunk destroyed, keyed by its project. */
const DESTROYED = "trunk-destroyed";

// JSON codecs: the domain's optional fields encode as absent keys, which is what EntityStore and the outbox hold.
const decodeTrunk = Schema.decodeUnknownSync(Schema.toCodecJson(Trunk));
const encodeTrunk = Schema.encodeSync(Schema.toCodecJson(Trunk));
const encodeEvent = Schema.encodeSync(Schema.toCodecJson(TrunkEvent));

const isTagged = (json: Schema.Json): json is EventDraft["payload"] =>
  typeof json === "object" &&
  json !== null &&
  !Array.isArray(json) &&
  "_tag" in json &&
  typeof json["_tag"] === "string";

const changeRef = (id: ChangeId): EntityRef => ({ kind: "change", id });

/** The changes an event is about, beyond the trunk: scoped subscribers (each member's Change DO) match on them. */
const changesOf = (event: TrunkEvent): readonly ChangeId[] => {
  switch (event._tag) {
    case "PromotionStarted":
      return event.members;
    case "PromotionComposed":
      return event.commits.map((c) => c.changeId);
    case "TrunkAdvanced":
      return event.landings.map((l) => l.changeId);
    case "PromotionDeclined":
      return event.reverify;
    default:
      return [];
  }
};

/** A trunk event as the outbox takes it, affecting the member changes it is about. */
const draftOf = (event: TrunkEvent): EventDraft => {
  const payload = encodeEvent(event);
  if (!isTagged(payload)) throw new Error(`${event._tag} did not encode as a tagged object`);
  const affected = changesOf(event).map(changeRef);
  return affected.length === 0 ? { payload } : { payload, affected };
};

/** The trunk as its events left it, or undefined before TrunkInitialized. */
export const trunkOf = (
  store: (typeof EntityStore)["Service"],
  projectId: ProjectId,
): Trunk | undefined => {
  const stored = store.get(TRUNK, projectId);
  return stored === undefined ? undefined : decodeTrunk(stored);
};

/** Whether the project's trunk was destroyed: it then takes no batch and its repos are deleted. */
export const trunkDestroyed = (
  store: (typeof EntityStore)["Service"],
  projectId: ProjectId,
): boolean => store.get(DESTROYED, projectId) !== undefined;

/** The quota a project's trunk counts against: its org's repo bytes. */
const REPO_BYTES = "repo-bytes";

/**
 * A pack's 12-byte header and 20-byte trailer. Every relayed pack carries
 * them and the repo keeps neither, so a landing adds its pack less these to
 * trunk (measured exact on Artifacts, which stores every object whole).
 */
export const PACK_OVERHEAD_BYTES = 32;

/**
 * The org a project's trunk counts against, or undefined for a project that
 * has no place yet: until every project is given one (the tenancy cutover),
 * such a project is neither weighed nor counted.
 */
const orgOf = (projectId: ProjectId) =>
  Effect.map(
    Effect.flatMap(ProjectOrgs, (places) => places.byId(projectId)),
    (place): OrgId | undefined => (Option.isSome(place) ? place.value.org : undefined),
  );

/**
 * Takes a composed group's pack out of its org's repo bytes, for a group
 * that ends without landing, with no record beside the trunk of whether it
 * was admitted. The pack is weighed again and admitted under the promotion's
 * own key: that answers as it first did, or counts now if it was never
 * asked. Only an admitted answer is then given back, under a key of its own,
 * so the count ends without this pack either way, a refused pack gives
 * nothing back, and a retry is a no-op. A pack too large to weigh was never
 * admitted.
 */
const giveBack = Effect.fn("integration/giveBack")(function* (
  projectId: ProjectId,
  old: CommitSha,
  sha: CommitSha,
) {
  const org = yield* orgOf(projectId);
  if (org === undefined) return;
  const weighed = yield* Effect.result((yield* TrunkWriter).packBytes(old, sha));
  if (Result.isFailure(weighed)) return;
  const bytes = weighed.success - PACK_OVERHEAD_BYTES;
  const usage = yield* OrgUsage;
  const admitted = yield* Effect.result(usage.admit(org, REPO_BYTES, bytes, `promotion:${sha}`));
  if (Result.isFailure(admitted)) return;
  yield* usage.record(org, REPO_BYTES, -bytes, `giveback:${sha}`);
});

/**
 * Runs one Promotion command in one transaction: decide on the folded trunk,
 * commit the events, and fold them into the stored trunk. A refusal writes
 * nothing. `cause` makes a retry a no-op, answering the trunk as it stands;
 * `fingerprint` tells a retry from a different command under the same cause.
 */
export const promote = Effect.fn("integration/promote")(function* (
  projectId: ProjectId,
  command: PromotionCommand,
  cause: string,
  fingerprint?: string,
) {
  const now = yield* (yield* Clock).now;
  return yield* commit(
    {
      entity: { kind: "trunk", id: projectId },
      cause,
      project: projectId,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    },
    (tx) =>
      Result.map(
        decidePromotion(trunkOf(tx.store, projectId), command, { now, projectId }),
        (events) => {
          const after = events.reduce<Trunk | undefined>(
            (trunk, payload) => evolvePromotion(trunk, { at: now, payload }),
            trunkOf(tx.store, projectId),
          );
          if (after !== undefined) tx.store.put(TRUNK, projectId, encodeTrunk(after));
          return { value: after, drafts: events.map(draftOf) };
        },
      ),
  );
});

/**
 * Names trunk's first head; before it nothing is queued or promoted. A retry
 * with the same head answers the trunk; another head is refused, as is any
 * initialize once trunk has a head. The repo's whole history at that head is
 * then counted into its org's repo bytes, once per project and never refused
 * (the project already exists); a project with no place yet counts nothing,
 * so a project is placed before its trunk is initialized.
 */
export const initializeTrunk = Effect.fn("integration/initializeTrunk")(function* (
  projectId: ProjectId,
  head: CommitSha,
  by: string,
) {
  const committed = yield* promote(projectId, { _tag: "Initialize", head, by }, "initialize", head);
  const trunk = trunkOf(yield* EntityStore, projectId);
  if (trunk === undefined)
    return yield* Effect.die(
      new Error(`trunk ${projectId} committed Initialize but holds no state`),
    );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new PromotionStateRefused({
      projectId,
      phase: trunk.phase,
      command: "Initialize",
    });
  const org = yield* orgOf(projectId);
  if (org !== undefined) {
    const bytes = yield* (yield* TrunkWriter).historyBytes(head);
    yield* (yield* OrgUsage).record(org, REPO_BYTES, bytes, `create:${projectId}`);
  }
  return trunk;
});

/**
 * Copies trunk's head into the project's staging and mirror, off the
 * promotion path: a lagging mirror is safe (a change's base is its
 * workspace's head), and trunk never waits on or fails by it. Idempotent.
 */
export const syncTrunk = Effect.fn("integration/syncTrunk")(function* (projectId: ProjectId) {
  const repos = projectRepos(projectId);
  const { head, outcomes } = yield* (yield* TrunkWriter).sync([repos.staging, repos.mirror]);
  const [staging, mirror] = outcomes;
  if (staging === undefined || mirror === undefined)
    return yield* Effect.die(new Error(`trunk ${projectId} synced ${outcomes.length} of 2 repos`));
  return { head, staging, mirror };
});

/** Copies trunk's head into the project's mirror after an advance; staging is the Lane's to move. Idempotent. A destroyed trunk syncs nothing. */
export const syncMirror = Effect.fn("integration/syncMirror")(function* (projectId: ProjectId) {
  if (trunkDestroyed(yield* EntityStore, projectId)) return undefined;
  const { head, outcomes } = yield* (yield* TrunkWriter).sync([projectRepos(projectId).mirror]);
  return { head, mirror: outcomes[0] };
});

/**
 * Marks the project's trunk destroyed, for good: from here on it takes no
 * batch, and `deleteProjectRepos` may delete its repos. `by` is who asked.
 * Destroying again is a no-op.
 */
export const destroyTrunk = Effect.fn("integration/destroyTrunk")(function* (
  projectId: ProjectId,
  by: string,
) {
  yield* commit(
    { entity: { kind: "trunk", id: projectId }, cause: "destroy", project: projectId },
    (tx) => {
      tx.store.put(DESTROYED, projectId, { by, at: tx.at });
      return Result.succeed({ value: undefined, drafts: [] });
    },
  );
});

/** What a deletion pass did; `pending` repos still await deletion. */
export interface DestroyReport {
  readonly deleted: number;
  readonly pending: number;
}

/**
 * Deletes every repo of a destroyed project: trunk, staging, the mirror and
 * the guards repo. A failed deletion stays pending for the next pass, and a
 * repo already gone counts as deleted. A trunk that was not destroyed keeps
 * its repos: nothing is deleted.
 */
export const deleteProjectRepos = Effect.fn("integration/deleteProjectRepos")(function* (
  projectId: ProjectId,
) {
  if (!trunkDestroyed(yield* EntityStore, projectId))
    return { deleted: 0, pending: 0 } satisfies DestroyReport;
  const host = yield* CodeHost;
  const repos = Object.values(projectRepos(projectId));
  const outcomes = yield* Effect.forEach(repos, (repo) => Effect.exit(host.delete(repo)), {
    concurrency: "unbounded",
  });
  const deleted = outcomes.filter(Exit.isSuccess).length;
  return { deleted, pending: repos.length - deleted } satisfies DestroyReport;
});

/** The one lane of a project at L1 (`lane:<projectId>:main`), until BatchVerified carries its lane. */
export const mainLane = (projectId: ProjectId): string => `lane:${projectId}:main`;

/** How long trunk waits after a BatchVerified for others to join it. */
export const DEBOUNCE_MS = 100;

const decodeVerified = Schema.decodeUnknownSync(BatchVerified);

/**
 * A delivered BatchVerified, inside the transaction that records it: Enqueue
 * folds it into the trunk's queue (the received event is the record, so
 * nothing is re-emitted), and its members and lane are subscribed to what
 * trunk does with it: each member's Change DO to the TrunkAdvanced that lands
 * it, the lane to every TrunkAdvanced and PromotionDeclined. A redelivery, a
 * batch trunk already holds, or one before TrunkInitialized (the domain
 * refuses it: a project's trunk is initialized before any change can exist)
 * changes nothing, and neither does any batch once the trunk is destroyed.
 * True when the trunk changed.
 */
export const trunkHeard = (
  tx: Transaction,
  projectId: ProjectId,
  event: EventEnvelope,
): boolean => {
  if (event.type !== "BatchVerified" || trunkDestroyed(tx.store, projectId)) return false;
  const verified = decodeVerified(event.payload);
  const { members, base } = verified;
  if (members === undefined || base === undefined)
    throw new Error(`BatchVerified ${verified.batchId} carries no members or base to promote`);
  const before = trunkOf(tx.store, projectId);
  // A batch the Lane re-offered after trunk promoted it (its TrunkAdvanced still on the way): taken, nothing changes.
  if (before !== undefined && members.every((member) => before.promoted.includes(member)))
    return true;
  const decided = decidePromotion(
    before,
    {
      _tag: "Enqueue",
      batchId: verified.batchId,
      candidateId: verified.candidateId,
      verdictId: verified.verdictId,
      members,
      base,
      predecessors: verified.predecessors ?? [],
      ...(verified.verified === undefined ? {} : { verified: verified.verified }),
    },
    { now: tx.at, projectId },
  );
  if (Result.isFailure(decided)) return false;
  const after = decided.success.reduce<Trunk | undefined>(
    (trunk, payload) => evolvePromotion(trunk, { at: tx.at, payload }),
    before,
  );
  if (after !== undefined) tx.store.put(TRUNK, projectId, encodeTrunk(after));
  for (const member of members)
    tx.outbox.subscribe(`change:${member}`, ["TrunkAdvanced"], changeRef(member));
  tx.outbox.subscribe(mainLane(projectId), ["TrunkAdvanced", "PromotionDeclined"]);
  return true;
};

const candidateRef = (candidateId: CandidateId) => `refs/heads/cand/${candidateId}`;

/** A candidate's commit in staging: its ref must be there, since the Lane pushed it before verifying. */
const candidateTip = (projectId: ProjectId, candidateId: CandidateId) =>
  Effect.flatMap(CodeHost, (host) =>
    host.head(projectRepos(projectId).staging, candidateRef(candidateId)).pipe(Effect.orDie),
  );

const NONE: Footprints = { changes: [], paths: [], affected: [], subjects: [] };

/**
 * What the commutation rule decides one queued batch on, at L1. The batch's
 * own paths come from its candidate in staging. L1 computes neither a
 * merge-tree of the batch onto a moved head nor the Affected closure, so only
 * a batch whose base is trunk's head can commute (nothing intervened); on a
 * moved head the merge is never proven clean, and the batch is declined to be
 * restacked and verified again.
 */
const factsOf = (projectId: ProjectId, head: CommitSha, batch: QueuedBatch) =>
  Effect.gen(function* () {
    const tip = yield* candidateTip(projectId, batch.candidateId);
    const changed = yield* (yield* CodeHost)
      .diffTrees(projectRepos(projectId).staging, batch.base, tip)
      .pipe(Effect.orDie);
    return {
      batchId: batch.batchId,
      touched: { ...NONE, changes: batch.members, paths: changed.map((c) => c.path) },
      intervening: NONE,
      mergeTreeClean: batch.base === head,
    } satisfies CommutationFacts;
  });

/**
 * The debounce deadline: reads trunk's head and the front batch's facts, then
 * decides the group in one commit. FIFO with one batch per group at L1, so
 * only the front batch's facts are looked up and the queue stops behind it. A
 * head trunk does not know freezes promotion. Answers the trunk's phase. A
 * destroyed trunk decides nothing: what it had queued stays queued.
 */
export const flushTrunk = Effect.fn("integration/flushTrunk")(function* (projectId: ProjectId) {
  const trunk = trunkOf(yield* EntityStore, projectId);
  if (trunk?.phase !== "debouncing" || trunkDestroyed(yield* EntityStore, projectId))
    return trunk?.phase;
  const observedHead = yield* (yield* TrunkWriter).head;
  const [front] = trunk.queue;
  const inputs = front === undefined ? [] : [yield* factsOf(projectId, trunk.head, front)];
  const now = yield* (yield* Clock).now;
  const groupId = `${front?.batchId ?? "empty"}@${now}`;
  yield* promote(
    projectId,
    { _tag: "Flush", observedHead, groupId, committerTime: now, barriers: [], inputs },
    `flush:${groupId}`,
  ).pipe(Effect.orDie);
  return trunkOf(yield* EntityStore, projectId)?.phase;
});

/** Where a push left the open group. */
export type PushOutcome =
  /** Trunk is at the group's commit: TrunkAdvanced is committed. */
  | "advanced"
  /** Trunk still holds the group's old head, or receive-pack was busy: push the same SHA again later. */
  | "retry"
  /** Trunk holds a head the WAL does not explain: PromotionFrozen is committed, and a person must look. */
  | "frozen"
  /** The group's push was refused (its pack is over the receive-pack cap, or over what is left of its org's repo-bytes quota) with trunk still on the old head: PromotionDeclined is committed for each batch, and the queue moves on. */
  | "declined"
  /** No group is open. */
  | "idle";

/** What a trunk with no group to push answers: a frozen one says so, every time it is asked. */
const restingAs = (trunk: Trunk | undefined): PushOutcome =>
  trunk?.phase === "frozen" ? "frozen" : "idle";

/**
 * Pushes the open group and reads trunk back (ADR 0003). At L1 a group is one
 * batch of one change, pushed as its candidate was composed: the WAL records
 * the candidate's commit once, before the first push, and every retry pushes
 * that SHA with the WAL's old value. The read-back decides: the recorded SHA
 * advances trunk, the old head means push again, anything else freezes.
 *
 * Before every push the group's pack is weighed and admitted against its
 * org's repo-bytes quota, under the key `promotion:<sha>`, so the retries of
 * one group count once. A pack over the receive-pack cap or over the quota,
 * with trunk still on the old head, is PushRefused: the group is declined,
 * never left open, and what was admitted for it is given back first. A
 * project with no place yet is pushed unweighed. A destroyed trunk pushes
 * nothing, even a group it had opened.
 */
export const pushPromotion = Effect.fn("integration/pushPromotion")(function* (
  projectId: ProjectId,
) {
  const opened = trunkOf(yield* EntityStore, projectId);
  const wal = opened?.wal;
  if (trunkDestroyed(yield* EntityStore, projectId)) return "idle" satisfies PushOutcome;
  if (opened?.phase !== "promoting" || wal === undefined) return restingAs(opened);
  if (wal.composed === undefined) {
    const [batch, ...more] = wal.batches;
    const [member, ...others] = batch?.members ?? [];
    if (batch === undefined || member === undefined || more.length > 0 || others.length > 0)
      return yield* Effect.die(
        new Error(
          `group ${wal.groupId} is not one batch of one: multi-member promotion is not built`,
        ),
      );
    const tip = yield* candidateTip(projectId, batch.candidateId);
    yield* promote(
      projectId,
      { _tag: "Composed", sha: tip, commits: [{ changeId: member, commitSha: tip }] },
      `composed:${wal.groupId}`,
    ).pipe(Effect.orDie);
  }
  const trunk = trunkOf(yield* EntityStore, projectId);
  const target = trunk === undefined ? undefined : pushTarget(trunk);
  if (trunk?.wal === undefined || target === undefined) return restingAs(trunk);
  const writer = yield* TrunkWriter;
  const usage = yield* OrgUsage;
  const org = yield* orgOf(projectId);
  /** Why this group cannot be pushed, when a refusal and not the state of trunk explains it. */
  let refused: PushRefusedReason | undefined;
  /** The bytes this group holds of its org's quota. */
  let admitted: number | undefined;
  if (org !== undefined) {
    const weighed = yield* Effect.result(writer.packBytes(trunk.wal.old, target));
    if (Result.isFailure(weighed)) refused = "pack-too-large";
    else {
      const bytes = weighed.success - PACK_OVERHEAD_BYTES;
      const answer = yield* Effect.result(
        usage.admit(org, REPO_BYTES, bytes, `promotion:${target}`),
      );
      if (Result.isFailure(answer)) refused = "repo-bytes-quota";
      else admitted = bytes;
    }
  }
  if (refused === undefined) {
    const pushed = yield* Effect.result(writer.push(trunk.wal.old, target));
    if (Result.isFailure(pushed)) {
      const failure = pushed.failure;
      if (failure._tag === "PackTooLarge") refused = "pack-too-large";
      else if (failure._tag === "PushRejected" && failure.reason === "busy")
        return "retry" satisfies PushOutcome;
      // Stale or an unexpected head: the read-back tells a lost acknowledgement from a moved trunk.
    }
  }
  if (refused !== undefined && (yield* writer.head) === trunk.wal.old) {
    // Nothing landed and no retry can help. What the group was admitted is given back before it is declined: a crash between the two then leaves the group open, and the next pass ends it.
    if (org !== undefined && admitted !== undefined)
      yield* usage.record(org, REPO_BYTES, -admitted, `giveback:${target}`);
    // The domain declines the group, so its change bounces and trunk stays free.
    yield* promote(
      projectId,
      { _tag: "PushRefused", reason: refused, observed: trunk.wal.old },
      `refused:${trunk.wal.groupId}:${refused}`,
    ).pipe(Effect.orDie);
    return "declined" satisfies PushOutcome;
  }
  const observed = yield* writer.head;
  yield* promote(
    projectId,
    { _tag: "ReadBack", observed },
    `readback:${trunk.wal.groupId}:${observed}`,
  ).pipe(Effect.orDie);
  const after = trunkOf(yield* EntityStore, projectId);
  if (after?.phase === "frozen") return "frozen" satisfies PushOutcome;
  return after?.phase === "promoting" ? "retry" : "advanced";
});

/**
 * An operator releases a freeze, confirming trunk's head as it reads now: the
 * stopped group's batches are declined for re-verification and promotion
 * resumes. A trunk that is not frozen is left as it is.
 *
 * The stopped group's pack is given back to its org's quota first, unless
 * trunk's head is the very commit the group composed (it landed after all).
 * Known limit: a head that holds that commit further down its history is not
 * recognised, and one pack then goes uncounted.
 */
export const resumeTrunk = Effect.fn("integration/resumeTrunk")(function* (
  projectId: ProjectId,
  by: string,
) {
  const head = yield* (yield* TrunkWriter).head;
  const now = yield* (yield* Clock).now;
  const stopped = trunkOf(yield* EntityStore, projectId);
  const composed = stopped?.phase === "frozen" ? stopped.wal?.composed : undefined;
  if (stopped?.wal !== undefined && composed !== undefined && composed !== head)
    yield* giveBack(projectId, stopped.wal.old, composed);
  yield* promote(projectId, { _tag: "Resume", by, head }, `resume:${by}@${now}`).pipe(
    Effect.catchTag("PromotionStateRefused", () => Effect.void),
    Effect.orDie,
  );
  const trunk = trunkOf(yield* EntityStore, projectId);
  if (trunk === undefined)
    return yield* Effect.die(new Error(`trunk ${projectId} is not initialized`));
  return trunk;
});
