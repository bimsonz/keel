import { Result, Schema } from "effect";
import {
  type BatchId,
  type CandidateId,
  type ChangeId,
  type CommitSha,
  type Committed,
  type ContentHash,
  IllegalTransition,
  type Instant,
  type ProjectId,
  type Tier,
  type VerdictId,
} from "../kernel/index.ts";
import { type Batch, type CandidateState, MAX_BATCH } from "./batch.ts";
import { CandidateStateRefused, InvalidBatch, ResultFenced } from "./errors.ts";
import {
  type BatchAttribution,
  BatchFailed,
  BatchFormed,
  BatchVerified,
  CandidateAssembled,
  CandidateBisected,
  CandidateInvalidated,
  CandidatePromoted,
  VerificationStarted,
} from "./events.ts";

/** The events a Lane DO commits for one batch and its candidate. */
export const CandidateEvent = Schema.Union([
  BatchFormed,
  CandidateAssembled,
  VerificationStarted,
  BatchVerified,
  BatchFailed,
  CandidateBisected,
  CandidatePromoted,
  CandidateInvalidated,
]);
export type CandidateEvent = typeof CandidateEvent.Type;

/** Which attempt a verification result belongs to: results are fenced on `(batchId, attempt, chainEpoch)`. */
export interface Fence {
  readonly attempt: number;
  readonly chainEpoch: number;
}

/** A command on a batch: the lane forming it, a GitCore or KeelVerify step reporting, or the Trunk DO's answer. */
export type CandidateCommand =
  | {
      readonly _tag: "Form";
      readonly laneId: string;
      readonly projectId: ProjectId;
      readonly members: readonly ChangeId[];
      readonly base: CommitSha;
      readonly predecessors: readonly ChangeId[];
      readonly attempt: number;
      readonly chainEpoch: number;
    }
  | {
      readonly _tag: "Assemble";
      readonly candidateId: CandidateId;
      readonly treeSha: CommitSha;
      readonly composer: "gitcore" | "mergebox";
      readonly tier: Tier;
      readonly tierReason: string;
    }
  | { readonly _tag: "RefuseComposition"; readonly verdictId: VerdictId }
  | {
      readonly _tag: "StartVerification";
      readonly instanceId: string;
      readonly planHash: ContentHash;
    }
  | ({ readonly _tag: "Verified"; readonly verdictId: VerdictId } & Fence)
  | ({
      readonly _tag: "Failed";
      readonly verdictId: VerdictId;
      readonly attribution: BatchAttribution;
    } & Fence)
  | { readonly _tag: "Bisect"; readonly into: readonly BatchId[] }
  | { readonly _tag: "Promote"; readonly trunkSha: CommitSha }
  | { readonly _tag: "Invalidate" };

/** Facts from I/O: the time, and the batch this decision is about (the Lane DO's key for it). */
export interface CandidateFacts {
  readonly now: Instant;
  readonly batchId: BatchId;
}

export type CandidateRejection = CandidateStateRefused | ResultFenced | InvalidBatch;

type Decision = Result.Result<readonly CandidateEvent[], CandidateRejection>;

/** A Red batch is bisected only when it has several members and nobody is blamed yet. */
export const isBisectable = (batch: Batch): boolean =>
  batch.state === "red" && batch.attribution === "unattributed" && batch.members.length > 1;

/** Promoted, Invalidated, Bisected, or Red with no bisection to come. */
export const isCandidateTerminal = (batch: Batch): boolean =>
  batch.state === "promoted" ||
  batch.state === "invalidated" ||
  batch.state === "bisected" ||
  (batch.state === "red" && !isBisectable(batch));

const refuse = (
  batchId: BatchId,
  state: CandidateState | undefined,
  command: CandidateCommand,
): Decision =>
  Result.fail(
    new CandidateStateRefused({
      batchId,
      ...(state === undefined ? {} : { state }),
      command: command._tag,
    }),
  );

const form = (batchId: BatchId, command: Extract<CandidateCommand, { _tag: "Form" }>): Decision => {
  if (command.members.length === 0 || command.members.length > MAX_BATCH) {
    return Result.fail(
      new InvalidBatch({
        batchId,
        reason: `a batch holds 1 to ${MAX_BATCH} changes, not ${command.members.length}`,
      }),
    );
  }
  if (new Set(command.members).size !== command.members.length)
    return Result.fail(new InvalidBatch({ batchId, reason: "a change appears twice" }));
  return Result.succeed([
    BatchFormed.make({
      batchId,
      laneId: command.laneId,
      members: command.members,
      base: command.base,
      attempt: command.attempt,
      chainEpoch: command.chainEpoch,
      projectId: command.projectId,
      predecessors: command.predecessors,
    }),
  ]);
};

/**
 * Decides a command on a batch (docs/domain/state-machines.md § Candidate).
 * Pure: every id and every result arrives in the command.
 */
export const decideCandidate = (
  state: Batch | undefined,
  command: CandidateCommand,
  facts: CandidateFacts,
): Decision => {
  if (state === undefined)
    return command._tag === "Form"
      ? form(facts.batchId, command)
      : refuse(facts.batchId, undefined, command);
  const batch = state;
  const batchId = batch.id;
  const fenced = (fence: Fence): boolean =>
    fence.attempt !== batch.attempt || fence.chainEpoch !== batch.chainEpoch;

  switch (command._tag) {
    case "Form":
      return refuse(batchId, batch.state, command);

    case "Assemble":
      return batch.state === "forming"
        ? Result.succeed([
            CandidateAssembled.make({
              candidateId: command.candidateId,
              batchId,
              treeSha: command.treeSha,
              composer: command.composer,
              tier: command.tier,
              tierReason: command.tierReason,
            }),
          ])
        : refuse(batchId, batch.state, command);

    case "RefuseComposition":
      return batch.state === "forming"
        ? Result.succeed([
            BatchFailed.make({ batchId, verdictId: command.verdictId, attribution: "textual" }),
          ])
        : refuse(batchId, batch.state, command);

    case "StartVerification":
      return batch.state === "assembled" && batch.candidateId !== undefined
        ? Result.succeed([
            VerificationStarted.make({
              candidateId: batch.candidateId,
              batchId,
              instanceId: command.instanceId,
              planHash: command.planHash,
            }),
          ])
        : refuse(batchId, batch.state, command);

    case "Verified":
      if (batch.state !== "verifying" || batch.candidateId === undefined)
        return refuse(batchId, batch.state, command);
      if (fenced(command))
        return Result.fail(
          new ResultFenced({ batchId, attempt: command.attempt, chainEpoch: command.chainEpoch }),
        );
      return Result.succeed([
        BatchVerified.make({
          batchId,
          candidateId: batch.candidateId,
          verdictId: command.verdictId,
          members: batch.members,
          base: batch.base,
          predecessors: batch.predecessors ?? [],
        }),
      ]);

    case "Failed": {
      if (batch.state !== "verifying" || batch.candidateId === undefined)
        return refuse(batchId, batch.state, command);
      if (fenced(command))
        return Result.fail(
          new ResultFenced({ batchId, attempt: command.attempt, chainEpoch: command.chainEpoch }),
        );
      const blamed = command.attribution;
      if (blamed === "textual")
        return Result.fail(
          new InvalidBatch({
            batchId,
            reason: "a textual failure is a refused composition, reported while forming",
          }),
        );
      if (blamed === "unattributed" && batch.members.length < 2)
        return Result.fail(
          new InvalidBatch({ batchId, reason: "a one-change batch's failure is that change's" }),
        );
      if (
        blamed !== "interaction" &&
        blamed !== "infra" &&
        blamed !== "unattributed" &&
        !batch.members.includes(blamed)
      ) {
        return Result.fail(
          new InvalidBatch({ batchId, reason: `${blamed} is not a member of the batch` }),
        );
      }
      return Result.succeed([
        BatchFailed.make({
          batchId,
          candidateId: batch.candidateId,
          verdictId: command.verdictId,
          attribution: blamed,
        }),
      ]);
    }

    case "Bisect":
      return isBisectable(batch) && batch.candidateId !== undefined && command.into.length > 0
        ? Result.succeed([
            CandidateBisected.make({ candidateId: batch.candidateId, batchId, into: command.into }),
          ])
        : refuse(batchId, batch.state, command);

    case "Promote":
      return batch.state === "green" && batch.candidateId !== undefined
        ? Result.succeed([
            CandidatePromoted.make({
              candidateId: batch.candidateId,
              batchId,
              trunkSha: command.trunkSha,
            }),
          ])
        : refuse(batchId, batch.state, command);

    case "Invalidate":
      return batch.state === "green" && batch.candidateId !== undefined
        ? Result.succeed([
            CandidateInvalidated.make({
              candidateId: batch.candidateId,
              batchId,
              reason: "head-moved",
            }),
          ])
        : refuse(batchId, batch.state, command);

    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Batch | undefined, event: CandidateEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a batch in ${state === undefined ? "no state" : state.state}`,
  );
};

/**
 * Folds one committed event into the batch, with its own table of which state
 * each event leaves from; anything else throws `IllegalTransition`.
 */
export const evolveCandidate = (
  state: Batch | undefined,
  committed: Committed<CandidateEvent>,
): Batch => {
  const event = committed.payload;
  if (state === undefined) {
    if (event._tag !== "BatchFormed" || event.projectId === undefined) return illegal(state, event);
    return {
      id: event.batchId,
      laneId: event.laneId,
      projectId: event.projectId,
      members: event.members,
      base: event.base,
      attempt: event.attempt,
      chainEpoch: event.chainEpoch,
      state: "forming",
      predecessors: event.predecessors ?? [],
    };
  }
  const batch = state;
  if (event._tag !== "BatchFormed" && event.batchId !== batch.id) return illegal(batch, event);
  switch (event._tag) {
    case "BatchFormed":
      return illegal(batch, event);
    case "CandidateAssembled":
      return batch.state === "forming"
        ? { ...batch, state: "assembled", candidateId: event.candidateId }
        : illegal(batch, event);
    case "VerificationStarted":
      return batch.state === "assembled" ? { ...batch, state: "verifying" } : illegal(batch, event);
    case "BatchVerified":
      return batch.state === "verifying" ? { ...batch, state: "green" } : illegal(batch, event);
    case "BatchFailed":
      return (batch.state === "forming" && event.attribution === "textual") ||
        (batch.state === "verifying" && event.attribution !== "textual")
        ? { ...batch, state: "red", attribution: event.attribution }
        : illegal(batch, event);
    case "CandidateBisected":
      return isBisectable(batch) ? { ...batch, state: "bisected" } : illegal(batch, event);
    case "CandidatePromoted":
      return batch.state === "green" ? { ...batch, state: "promoted" } : illegal(batch, event);
    case "CandidateInvalidated":
      return batch.state === "green" ? { ...batch, state: "invalidated" } : illegal(batch, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a batch from its events in `seq` order. */
export const replayCandidate = (events: readonly Committed<CandidateEvent>[]): Batch | undefined =>
  events.reduce<Batch | undefined>((state, event) => evolveCandidate(state, event), undefined);
