import { Result, Schema } from "effect";
import type { PushRefusedReason } from "../coordination/index.ts";
import {
  type BatchId,
  type CandidateId,
  type ChangeId,
  type CommitSha,
  type Committed,
  type Glob,
  IllegalTransition,
  type Instant,
  type NextAction,
  type ProjectId,
  type VerdictId,
} from "../kernel/index.ts";
import { isVerified, type PendingGroup, type QueuedBatch, type Trunk } from "./batch.ts";
import { commutation, type Footprints } from "./commutation.ts";
import { CompositionMismatch, PromotionStateRefused, TrunkNotInitialized } from "./errors.ts";
import {
  BatchVerified,
  type MemberCommit,
  type MemberLanding,
  PromotionComposed,
  PromotionDeclined,
  PromotionFrozen,
  PromotionResumed,
  PromotionStarted,
  TrunkAdvanced,
  TrunkInitialized,
  type TrunkOrigin,
} from "./events.ts";

/**
 * What the Trunk DO's state is folded from: its own events, and the
 * `BatchVerified` it received (recorded in the same transaction as its
 * reaction, ADR 0009). Replaying both in commit order rebuilds the trunk.
 */
export const TrunkEvent = Schema.Union([
  TrunkInitialized,
  BatchVerified,
  PromotionDeclined,
  PromotionStarted,
  PromotionComposed,
  TrunkAdvanced,
  PromotionFrozen,
  PromotionResumed,
]);
export type TrunkEvent = typeof TrunkEvent.Type;

/** What the Trunk DO looked up for one queued batch before the debounce deadline's decision. */
export interface CommutationFacts {
  readonly batchId: BatchId;
  readonly touched: Footprints;
  /** The changes that landed since the batch's base and are not its predecessors. */
  readonly intervening: Footprints;
  /** GitCore's merge-tree of the batch onto head was clean. */
  readonly mergeTreeClean: boolean;
}

export type PromotionCommand =
  | {
      readonly _tag: "Initialize";
      readonly head: CommitSha;
      readonly by: string;
      /** Where the head came from, recorded on TrunkInitialized as given. */
      readonly origin?: TrunkOrigin;
    }
  | {
      readonly _tag: "Enqueue";
      readonly batchId: BatchId;
      readonly candidateId: CandidateId;
      readonly verdictId: VerdictId;
      readonly members: readonly ChangeId[];
      readonly base: CommitSha;
      readonly predecessors: readonly ChangeId[];
      /** The received `BatchVerified.verified`, kept as it came. */
      readonly verified?: boolean;
    }
  | {
      /** The debounce deadline: decide the group, write the WAL entry. */
      readonly _tag: "Flush";
      readonly observedHead: CommitSha;
      readonly groupId: string;
      readonly committerTime: Instant;
      readonly barriers: readonly Glob[];
      readonly inputs: readonly CommutationFacts[];
    }
  | {
      /** The group's composed chain: its last commit, and each member's commit in group order. */
      readonly _tag: "Composed";
      readonly sha: CommitSha;
      readonly commits: readonly MemberCommit[];
    }
  | { readonly _tag: "ReadBack"; readonly observed: CommitSha }
  | {
      /**
       * Artifacts refused the group's push, or the composed pack would take
       * the repo past its quota, and trunk is still on the old head as
       * `observed` says. A push that may have landed goes through ReadBack.
       */
      readonly _tag: "PushRefused";
      readonly reason: PushRefusedReason;
      readonly observed: CommitSha;
    }
  | { readonly _tag: "Resume"; readonly by: string; readonly head: CommitSha };

/** Facts from I/O: the time, and the project whose trunk this is (the Trunk DO's key). */
export interface PromotionFacts {
  readonly now: Instant;
  readonly projectId: ProjectId;
}

export type PromotionRejection = TrunkNotInitialized | PromotionStateRefused | CompositionMismatch;

type Decision = Result.Result<readonly TrunkEvent[], PromotionRejection>;

const refuse = (trunk: Trunk, command: PromotionCommand): Decision =>
  Result.fail(
    new PromotionStateRefused({
      projectId: trunk.projectId,
      phase: trunk.phase,
      command: command._tag,
    }),
  );

/** The group's members in group order: its batches front to back, each batch's members in its own order. */
const membersOf = (group: PendingGroup): readonly ChangeId[] =>
  group.batches.flatMap((b) => b.members);

const sameChain = (commits: readonly MemberCommit[], group: PendingGroup): boolean => {
  const members = membersOf(group);
  return commits.length === members.length && commits.every((c, i) => c.changeId === members[i]);
};

/** Each member's landing: its commit on trunk, and its own batch's candidate and proof. */
const landingsOf = (group: PendingGroup, commits: readonly MemberCommit[]): MemberLanding[] =>
  group.batches.flatMap((batch, i) =>
    batch.members.flatMap((changeId) => {
      const commit = commits.find((c) => c.changeId === changeId);
      const proofId = group.proofIds[i];
      return commit === undefined || proofId === undefined
        ? []
        : [{ changeId, commitSha: commit.commitSha, candidateId: batch.candidateId, proofId }];
    }),
  );

/**
 * What the members' agents can do about a refused push. A pack too large for
 * one batch alone is the change's to split; in a group of several, no batch
 * is blamed and each is verified again and promoted alone. A full repo is for
 * a person to make room in.
 */
const refusedActions = (reason: PushRefusedReason, alone: boolean): readonly NextAction[] => {
  if (reason === "repo-bytes-quota")
    return [
      {
        kind: "escalate",
        title:
          "The repo is at its size quota: ask an owner to free space, or whoever runs this Keel to raise the quota",
      },
      { kind: "call", title: "Submit the change again once there is room", operationId: "submit" },
    ];
  return alone
    ? [
        {
          kind: "call",
          title:
            "The change's pack is too large to push: declare part of the work as its own change",
          operationId: "declare",
        },
        {
          kind: "call",
          title: "Submit this change again with a smaller commit",
          operationId: "submit",
        },
      ]
    : [
        {
          kind: "wait",
          title:
            "The group's pack was too large to push: each batch is verified again and promoted alone",
        },
      ];
};

/** The SHA a push of the open group must carry: recorded once, before the first push, and never recomposed. */
export const pushTarget = (trunk: Trunk): CommitSha | undefined =>
  trunk.phase === "promoting" ? trunk.wal?.composed : undefined;

/**
 * The debounce deadline. Queued batches are taken in arrival order: one that
 * commutes onto the head joins the group, one that does not is declined for
 * re-verification, and one waiting on an unpromoted predecessor stops the
 * queue there, as does one whose facts were not looked up.
 */
const flush = (trunk: Trunk, command: Extract<PromotionCommand, { _tag: "Flush" }>): Decision => {
  const { projectId } = trunk;
  if (command.observedHead !== trunk.head) {
    return Result.succeed([
      PromotionFrozen.make({
        projectId,
        groupId: command.groupId,
        expected: trunk.head,
        observed: command.observedHead,
        reason: "head-moved",
      }),
    ]);
  }
  const events: TrunkEvent[] = [];
  const group: {
    readonly batch: QueuedBatch;
    readonly touched: Footprints;
    readonly proofId: string;
  }[] = [];
  for (const batch of trunk.queue) {
    const facts = command.inputs.find((input) => input.batchId === batch.batchId);
    if (facts === undefined) break;
    const outcome = commutation({
      batch: {
        id: batch.batchId,
        base: batch.base,
        predecessors: batch.predecessors,
        touched: facts.touched,
      },
      intervening: facts.intervening,
      head: trunk.head,
      promoted: [...trunk.promoted, ...group.flatMap((g) => g.batch.members)],
      mergeTreeClean: facts.mergeTreeClean,
      barriers: command.barriers,
      group: group.map((g) => ({ id: g.batch.batchId, touched: g.touched })),
    });
    if (outcome._tag === "wait") break;
    if (outcome._tag === "reverify") {
      events.push(
        PromotionDeclined.make({
          projectId,
          batchId: batch.batchId,
          reason: "commutation-failed",
          reverify: batch.members,
        }),
      );
      continue;
    }
    group.push({ batch, touched: facts.touched, proofId: outcome.proofId });
    // After a group's pack was refused as too large, one batch at a time until a push lands.
    if (trunk.solo === true) break;
  }
  if (group.length > 0) {
    events.push(
      PromotionStarted.make({
        projectId,
        groupId: command.groupId,
        old: trunk.head,
        members: group.flatMap((g) => g.batch.members),
        batches: group.map((g) => g.batch.batchId),
        proofIds: group.map((g) => g.proofId),
        committerTime: command.committerTime,
      }),
    );
  }
  return Result.succeed(events);
};

/**
 * Decides a command on the trunk (docs/domain/state-machines.md § Promotion,
 * ADR 0003). Pure: the head read back, the composed SHA and every id arrive
 * in the command.
 */
export const decidePromotion = (
  state: Trunk | undefined,
  command: PromotionCommand,
  facts: PromotionFacts,
): Decision => {
  if (state === undefined) {
    return command._tag === "Initialize"
      ? Result.succeed([
          TrunkInitialized.make({
            projectId: facts.projectId,
            head: command.head,
            by: command.by,
            ...(command.origin === undefined ? {} : { origin: command.origin }),
          }),
        ])
      : Result.fail(new TrunkNotInitialized({ projectId: facts.projectId }));
  }
  const trunk = state;
  const { projectId, wal } = trunk;

  switch (command._tag) {
    case "Initialize":
      return refuse(trunk, command);

    case "Enqueue": {
      const known = [...trunk.queue, ...(wal?.batches ?? [])].some(
        (b) => b.batchId === command.batchId,
      );
      return known
        ? refuse(trunk, command)
        : Result.succeed([
            BatchVerified.make({
              batchId: command.batchId,
              candidateId: command.candidateId,
              verdictId: command.verdictId,
              members: command.members,
              base: command.base,
              predecessors: command.predecessors,
              ...(command.verified === undefined ? {} : { verified: command.verified }),
            }),
          ]);
    }

    case "Flush":
      return trunk.phase === "debouncing" ? flush(trunk, command) : refuse(trunk, command);

    case "Composed":
      if (trunk.phase !== "promoting" || wal === undefined) return refuse(trunk, command);
      if (!sameChain(command.commits, wal))
        return Result.fail(
          new CompositionMismatch({
            projectId,
            groupId: wal.groupId,
            expected: membersOf(wal),
            got: command.commits.map((c) => c.changeId),
            nextActions: [
              {
                kind: "escalate",
                title: "The composer's chain does not match the promotion group; ask an operator",
              },
            ],
          }),
        );
      if (wal.composed === undefined)
        return Result.succeed([
          PromotionComposed.make({
            projectId,
            groupId: wal.groupId,
            sha: command.sha,
            commits: command.commits,
          }),
        ]);
      // A recompose that disagrees with the recorded SHA is never pushed: it is an alert.
      return command.sha === wal.composed
        ? Result.succeed([])
        : Result.succeed([
            PromotionFrozen.make({
              projectId,
              groupId: wal.groupId,
              expected: wal.composed,
              observed: command.sha,
              reason: "recompose-mismatch",
            }),
          ]);

    case "ReadBack":
      if (trunk.phase !== "promoting" || wal?.composed === undefined || wal.commits === undefined)
        return refuse(trunk, command);
      if (command.observed === wal.old) return Result.succeed([]);
      if (command.observed === wal.composed) {
        return Result.succeed([
          TrunkAdvanced.make({
            projectId,
            from: wal.old,
            to: wal.composed,
            groupId: wal.groupId,
            landings: landingsOf(wal, wal.commits),
            // One unverified batch makes the whole advance unverified.
            ...(wal.batches.every(isVerified) ? {} : { verified: false }),
            ...(trunk.height === undefined ? {} : { height: trunk.height + 1 }),
          }),
        ]);
      }
      return Result.succeed([
        PromotionFrozen.make({
          projectId,
          groupId: wal.groupId,
          expected: wal.composed,
          observed: command.observed,
          reason: "readback-mismatch",
        }),
      ]);

    case "PushRefused": {
      if (
        trunk.phase !== "promoting" ||
        wal?.composed === undefined ||
        command.observed !== wal.old
      )
        return refuse(trunk, command);
      // Only a batch refused on its own is known to be too large; a full repo is no batch's fault to verify away.
      const alone = wal.batches.length === 1;
      const bounces = alone || command.reason === "repo-bytes-quota";
      return Result.succeed(
        wal.batches.map((b) =>
          PromotionDeclined.make({
            projectId,
            batchId: b.batchId,
            reason: command.reason,
            reverify: bounces ? [] : b.members,
            nextActions: refusedActions(command.reason, alone),
          }),
        ),
      );
    }

    case "Resume":
      return trunk.phase === "frozen"
        ? Result.succeed([
            ...(wal?.batches ?? []).map((b) =>
              PromotionDeclined.make({
                projectId,
                batchId: b.batchId,
                reason: "frozen",
                reverify: b.members,
              }),
            ),
            PromotionResumed.make({ projectId, by: command.by, head: command.head }),
          ])
        : refuse(trunk, command);

    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Trunk | undefined, event: TrunkEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a trunk ${state === undefined ? "not yet initialized" : state.phase}`,
  );
};

/** Idle when nothing waits, otherwise debouncing again: the Trunk DO re-arms the debounce. */
const settled = (queue: readonly QueuedBatch[]): Trunk["phase"] =>
  queue.length === 0 ? "idle" : "debouncing";

const without = <T extends object, K extends keyof T>(
  value: T,
  ...keys: readonly K[]
): Omit<T, K> => {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
};

/**
 * Folds one committed or received event into the trunk, with its own table of
 * which phase each event leaves from; anything else throws `IllegalTransition`.
 */
export const evolvePromotion = (
  state: Trunk | undefined,
  committed: Committed<TrunkEvent>,
): Trunk => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "TrunkInitialized"
      ? {
          projectId: event.projectId,
          phase: "idle",
          head: event.head,
          queue: [],
          promoted: [],
          height: 0,
          ...(event.origin === undefined ? {} : { origin: event.origin }),
        }
      : illegal(state, event);
  }
  const trunk = state;
  const { wal } = trunk;
  switch (event._tag) {
    case "TrunkInitialized":
      return illegal(trunk, event);

    case "BatchVerified": {
      if (
        event.members === undefined ||
        event.base === undefined ||
        trunk.queue.some((b) => b.batchId === event.batchId)
      )
        return illegal(trunk, event);
      const queued: QueuedBatch = {
        batchId: event.batchId,
        candidateId: event.candidateId,
        verdictId: event.verdictId,
        members: event.members,
        base: event.base,
        predecessors: event.predecessors ?? [],
        ...(event.verified === undefined ? {} : { verified: event.verified }),
      };
      return {
        ...trunk,
        queue: [...trunk.queue, queued],
        phase: trunk.phase === "idle" ? "debouncing" : trunk.phase,
      };
    }

    case "PromotionDeclined": {
      if (event.reason === "frozen") {
        return trunk.phase === "frozen" &&
          wal !== undefined &&
          wal.batches.some((b) => b.batchId === event.batchId)
          ? {
              ...trunk,
              wal: { ...wal, batches: wal.batches.filter((b) => b.batchId !== event.batchId) },
            }
          : illegal(trunk, event);
      }
      if (event.reason === "pack-too-large" || event.reason === "repo-bytes-quota") {
        if (
          trunk.phase !== "promoting" ||
          wal?.composed === undefined ||
          !wal.batches.some((b) => b.batchId === event.batchId)
        )
          return illegal(trunk, event);
        const batches = wal.batches.filter((b) => b.batchId !== event.batchId);
        // The group's last batch ends it: trunk never moved, so there is nothing to read back.
        const left: Trunk =
          batches.length > 0
            ? { ...trunk, wal: { ...wal, batches } }
            : { ...without(trunk, "wal"), phase: settled(trunk.queue) };
        // Members sent to be verified again were refused as a group: promote one batch at a time.
        return event.reason === "pack-too-large" && event.reverify.length > 0
          ? { ...left, solo: true }
          : left;
      }
      if (trunk.phase !== "debouncing" || !trunk.queue.some((b) => b.batchId === event.batchId))
        return illegal(trunk, event);
      const queue = trunk.queue.filter((b) => b.batchId !== event.batchId);
      return { ...trunk, queue, phase: settled(queue) };
    }

    case "PromotionStarted": {
      // The group is the front of the queue, in order: FIFO, with the declined already gone.
      const front = trunk.queue.slice(0, event.batches.length);
      const inOrder =
        front.length === event.batches.length &&
        front.every((b, i) => b.batchId === event.batches[i]);
      if (
        trunk.phase !== "debouncing" ||
        event.old !== trunk.head ||
        event.batches.length === 0 ||
        !inOrder
      )
        return illegal(trunk, event);
      return {
        ...trunk,
        phase: "promoting",
        queue: trunk.queue.slice(event.batches.length),
        wal: {
          groupId: event.groupId,
          old: event.old,
          batches: front,
          proofIds: event.proofIds,
          committerTime: event.committerTime,
        },
      };
    }

    case "PromotionComposed":
      return trunk.phase === "promoting" &&
        wal !== undefined &&
        wal.groupId === event.groupId &&
        wal.composed === undefined &&
        sameChain(event.commits, wal)
        ? { ...trunk, wal: { ...wal, composed: event.sha, commits: event.commits } }
        : illegal(trunk, event);

    case "TrunkAdvanced":
      return trunk.phase === "promoting" &&
        wal !== undefined &&
        wal.groupId === event.groupId &&
        wal.old === event.from &&
        wal.composed === event.to &&
        event.landings.map((l) => l.changeId).join() === membersOf(wal).join() &&
        (event.height === undefined ||
          trunk.height === undefined ||
          event.height === trunk.height + 1)
        ? {
            // An advance without a height (an older Trunk DO's) leaves the height unknown.
            // A push landed: grouping resumes.
            ...without(trunk, "wal", "height", "solo"),
            head: event.to,
            promoted: [...trunk.promoted, ...event.landings.map((l) => l.changeId)],
            phase: settled(trunk.queue),
            ...(event.height === undefined ? {} : { height: event.height }),
          }
        : illegal(trunk, event);

    case "PromotionFrozen": {
      const atFlush = trunk.phase === "debouncing" && event.expected === trunk.head;
      const inGroup =
        trunk.phase === "promoting" && wal !== undefined && wal.groupId === event.groupId;
      return atFlush || inGroup
        ? {
            ...trunk,
            phase: "frozen",
            frozen: {
              expected: event.expected,
              observed: event.observed,
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            },
          }
        : illegal(trunk, event);
    }

    case "PromotionResumed":
      return trunk.phase === "frozen" && (wal === undefined || wal.batches.length === 0)
        ? {
            ...without(trunk, "wal", "frozen"),
            head: event.head ?? trunk.head,
            phase: settled(trunk.queue),
          }
        : illegal(trunk, event);

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds the trunk from its received and committed events, in commit order. */
export const replayPromotion = (events: readonly Committed<TrunkEvent>[]): Trunk | undefined =>
  events.reduce<Trunk | undefined>((state, event) => evolvePromotion(state, event), undefined);
