// Where each change stands in Keel's flow, and when it got there: the fold
// the Pipeline is drawn from. The World keeps what each thing is;
// this keeps what moves, by the event that moved it and the time it did, so a
// change is drawn in the stage Keel last put it in, a batch is drawn with the
// batches it was formed on, and trunk's advances are kept with what each
// carried. Nothing here is inferred: every field is set by the event named
// beside it, and a stage is left only on an event that says so.

import type { AnyEvent } from "../contract/events.ts";

/** The stages a change is drawn in, left to right, and where it goes when it is done. */
export type Stage = "declared" | "precheck" | "queue" | "batch" | "bounced" | "landed" | "gone";

export interface FlowChange {
  id: string;
  stage: Stage;
  /** When it came into its stage, in the log's own milliseconds. */
  since: number;
  /** Where it was before it went where it is: a move is drawn from here. */
  from?: Stage;
  /** Keel parked it where it stands, for this reason, and the question a person is asked, where there is one. */
  parked?: { reason: string; escalationId?: string };
  /** Keel took it out of a batch and queued it again, for this reason. */
  requeued?: string;
  /** Moves it has made, so a reader can tell a move from a fresh draw. */
  moves: number;
  /** Trunk's commit its workspace was made on: `ChangeStarted.baseSha`, then `ChangeSubmitted`'s, then a rebase's. */
  base?: string;
  /** The paths it touches: declared in its footprint, then those its diff touched (`EffectsDerived.paths`). */
  paths: string[];
  /** Whether Keel has said which paths its diff touched. */
  touched: boolean;
  /** Trunk's commit that carried it, by `TrunkAdvanced.landings`. */
  landedIn?: string;
}

/** How a batch ended, by the event that ended it. */
export type BatchEnd =
  | "green"
  | "red"
  | "bisected"
  | "invalidated"
  | "promoted"
  | "declined"
  | "landed";

type StepFinished = Extract<AnyEvent, { type: "VerificationStepFinished" }>["payload"];

/** One step of a batch's verification, as Keel's step events tell it: started, then what it came to. */
export interface FlowStep {
  id: string;
  startedT: number;
  finished?: {
    t: number;
    outcome: StepFinished["outcome"];
    durationMs: number;
    failure?: StepFinished["failure"];
  };
}

export interface FlowBatch {
  id: string;
  laneId: string;
  members: string[];
  /** Trunk's commit it was formed on. */
  base: string;
  /** The changes trunk does not hold yet that it was formed on: those of the batches before it in flight. */
  predecessors: string[];
  attempt: number;
  chainEpoch: number;
  formedT: number;
  assembled?: { t: number; tier: number; composer: string };
  /** When its verification started, by `VerificationStarted`. */
  verifyingT?: number;
  /** Its steps in the order they started, by `VerificationStepStarted` and `VerificationStepFinished`. */
  steps: FlowStep[];
  ended?: {
    t: number;
    how: BatchEnd;
    verdictId?: string;
    /** `BatchFailed.attribution`: a change's id, or what Keel blamed. */
    attribution?: string;
    /** `CandidateBisected.into`. */
    into?: string[];
    /** `CandidateInvalidated.reason` or `PromotionDeclined.reason`. */
    reason?: string;
  };
}

export interface FlowCommit {
  height: number;
  sha: string;
  t: number;
  /** The changes the advance landed, in Keel's order. */
  changes: string[];
  verified: boolean;
}

/** Trunk's advances kept for the canvas. */
const COMMITS_KEPT = 4096;

const STAGE_OF: Partial<Record<AnyEvent["type"], Stage>> = {
  IntentDeclared: "declared",
  ChangeStarted: "declared",
  IntentRevised: "declared",
  ChangeAdopted: "declared",
  ChangeSubmitted: "precheck",
  PrecheckStarted: "precheck",
  EffectsDerived: "precheck",
  PlanCompiled: "precheck",
  ChangeDrifted: "precheck",
  ChangeRebased: "precheck",
  ChangeResumed: "precheck",
  ChangeQueued: "queue",
  ChangeRequeued: "queue",
  ChangeBatched: "batch",
  ChangeLanded: "landed",
  ChangeBounced: "bounced",
  ChangeWithdrawn: "gone",
  ChangeSuperseded: "gone",
};

/**
 * Whether Keel parked a change because its agent's lease lapsed: nothing of Keel's moves it until its agent, or
 * another, picks it up again. It is waiting on its agent, as the list of changes says, and it is not live.
 */
export function waitsOnItsAgent(change: { parked?: { reason: string } | undefined }): boolean {
  return change.parked?.reason === "lease-lapsed";
}

export class Flow {
  readonly changes = new Map<string, FlowChange>();
  readonly batches = new Map<string, FlowBatch>();
  /** Newest first. */
  readonly commits: FlowCommit[] = [];
  /** Groups Keel has started to put on trunk and not yet advanced it by: `PromotionStarted` to `TrunkAdvanced`. */
  readonly promoting = new Map<string, { batches: string[]; members: string[]; t: number }>();
  /** When each landing was, by `TrunkAdvanced`, oldest first. */
  readonly landings: number[] = [];

  #batch(id: string): FlowBatch | undefined {
    return this.batches.get(id);
  }

  #end(id: string, t: number, end: Omit<NonNullable<FlowBatch["ended"]>, "t">): void {
    const batch = this.#batch(id);
    if (batch !== undefined) batch.ended = { t, ...end };
  }

  apply(event: AnyEvent, t: number): void {
    const stage = STAGE_OF[event.type];
    if (
      stage !== undefined &&
      "changeId" in event.payload &&
      typeof event.payload.changeId === "string"
    )
      this.#move(event, event.payload.changeId, stage, t);
    switch (event.type) {
      case "IntentDeclared":
      case "IntentRevised": {
        const change = this.changes.get(event.payload.changeId);
        if (change !== undefined && !change.touched && event.payload.footprint !== undefined)
          change.paths = event.payload.footprint.map((entry) => entry.path);
        break;
      }
      case "ChangeStarted":
      case "ChangeSubmitted": {
        const change = this.changes.get(event.payload.changeId);
        if (change !== undefined && event.payload.baseSha !== undefined)
          change.base = event.payload.baseSha;
        break;
      }
      case "ChangeRebased": {
        const change = this.changes.get(event.payload.changeId);
        if (change !== undefined) change.base = event.payload.to;
        break;
      }
      case "EffectsDerived": {
        const change = this.changes.get(event.payload.changeId);
        if (change !== undefined && event.payload.paths !== undefined) {
          change.paths = [...event.payload.paths];
          change.touched = true;
        }
        break;
      }
      case "ChangeParked": {
        const change = this.changes.get(event.payload.changeId);
        if (change === undefined) break;
        change.parked = {
          reason: event.payload.reason,
          ...(event.payload.escalationId === undefined
            ? {}
            : { escalationId: event.payload.escalationId }),
        };
        break;
      }
      case "BatchFormed": {
        this.batches.set(event.payload.batchId, {
          id: event.payload.batchId,
          laneId: event.payload.laneId,
          members: [...event.payload.members],
          base: event.payload.base,
          predecessors: [...(event.payload.predecessors ?? [])],
          attempt: event.payload.attempt,
          chainEpoch: event.payload.chainEpoch,
          formedT: t,
          steps: [],
        });
        break;
      }
      case "CandidateAssembled": {
        const batch = this.#batch(event.payload.batchId);
        if (batch !== undefined)
          batch.assembled = { t, tier: event.payload.tier, composer: event.payload.composer };
        break;
      }
      case "VerificationStarted": {
        const batch = this.#batch(event.payload.batchId);
        if (batch !== undefined) batch.verifyingT = t;
        break;
      }
      // A step of a conflict's world matrix names its world; a batch's own steps name none.
      case "VerificationStepStarted": {
        const batch = this.#batch(event.payload.batchId);
        if (batch === undefined || event.payload.world !== undefined) break;
        if (!batch.steps.some((step) => step.id === event.payload.stepId))
          batch.steps.push({ id: event.payload.stepId, startedT: t });
        break;
      }
      case "VerificationStepFinished": {
        const batch = this.#batch(event.payload.batchId);
        if (batch === undefined || event.payload.world !== undefined) break;
        let step = batch.steps.find((each) => each.id === event.payload.stepId);
        if (step === undefined) {
          step = { id: event.payload.stepId, startedT: t };
          batch.steps.push(step);
        }
        step.finished = {
          t,
          outcome: event.payload.outcome,
          durationMs: event.payload.durationMs,
          ...(event.payload.failure === undefined ? {} : { failure: event.payload.failure }),
        };
        break;
      }
      case "BatchVerified": {
        this.#end(event.payload.batchId, t, { how: "green", verdictId: event.payload.verdictId });
        break;
      }
      case "BatchFailed": {
        this.#end(event.payload.batchId, t, {
          how: "red",
          verdictId: event.payload.verdictId,
          attribution: event.payload.attribution,
        });
        break;
      }
      case "CandidateBisected": {
        this.#end(event.payload.batchId, t, { how: "bisected", into: [...event.payload.into] });
        break;
      }
      case "CandidateInvalidated": {
        this.#end(event.payload.batchId, t, { how: "invalidated", reason: event.payload.reason });
        break;
      }
      case "CandidatePromoted": {
        const batch = this.#batch(event.payload.batchId);
        // A batch Keel has passed and is putting on trunk: it is still green until trunk has it.
        if (batch?.ended !== undefined) batch.ended = { ...batch.ended, how: "promoted" };
        break;
      }
      case "PromotionStarted": {
        this.promoting.set(event.payload.groupId, {
          batches: [...event.payload.batches],
          members: [...event.payload.members],
          t,
        });
        break;
      }
      case "PromotionDeclined": {
        this.#end(event.payload.batchId, t, { how: "declined", reason: event.payload.reason });
        for (const [groupId, group] of this.promoting)
          if (group.batches.includes(event.payload.batchId)) this.promoting.delete(groupId);
        break;
      }
      case "TrunkInitialized": {
        // Where trunk starts: a commit that landed no change. Its height is none, as the world has it.
        if (this.commits.length === 0)
          this.commits.unshift({
            height: 0,
            sha: event.payload.head,
            t,
            changes: [],
            verified: true,
          });
        break;
      }
      case "TrunkSynced": {
        // Trunk's head is upstream's own commit now: an advance that landed no change.
        this.commits.unshift({
          height: event.payload.height ?? (this.commits[0]?.height ?? 0) + 1,
          sha: event.payload.to,
          t,
          changes: [],
          verified: true,
        });
        if (this.commits.length > COMMITS_KEPT) this.commits.length = COMMITS_KEPT;
        break;
      }
      case "TrunkAdvanced": {
        const group = this.promoting.get(event.payload.groupId);
        this.promoting.delete(event.payload.groupId);
        for (const batchId of group?.batches ?? []) {
          const batch = this.#batch(batchId);
          if (batch !== undefined) batch.ended = { ...batch.ended, t, how: "landed" };
        }
        this.commits.unshift({
          height: event.payload.height ?? (this.commits[0]?.height ?? 0) + 1,
          sha: event.payload.to,
          t,
          changes: event.payload.landings.map((landing) => landing.changeId),
          verified: event.payload.verified !== false,
        });
        if (this.commits.length > COMMITS_KEPT) this.commits.length = COMMITS_KEPT;
        for (const landing of event.payload.landings) {
          this.landings.push(t);
          const change = this.changes.get(landing.changeId);
          if (change !== undefined) change.landedIn = event.payload.to;
        }
        break;
      }
      default:
        break;
    }
  }

  #move(event: AnyEvent, changeId: string, stage: Stage, t: number): void {
    const change = this.changes.get(changeId);
    if (change === undefined) {
      // A change is drawn from its declaration. One the log names first by a later event (read from the middle
      // of a log) is drawn where that event puts it.
      this.changes.set(changeId, {
        id: changeId,
        stage,
        since: t,
        moves: 0,
        paths: [],
        touched: false,
      });
      return;
    }
    if (event.type === "ChangeRequeued") change.requeued = event.payload.reason;
    else if (stage !== "queue") delete change.requeued;
    // A park holds where it was put until Keel moves the change on.
    delete change.parked;
    if (change.stage === stage) return;
    change.from = change.stage;
    change.stage = stage;
    change.since = t;
    change.moves += 1;
  }
}
