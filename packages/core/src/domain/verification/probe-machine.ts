import { Result, Schema } from "effect";
import {
  type Committed,
  type ConflictId,
  type ContentHash,
  type DecisionId,
  type GuardId,
  IllegalTransition,
  type Instant,
  type NextAction,
  type ProbeId,
} from "../kernel/index.ts";
import type { Conflict, World } from "./conflict.ts";
import { ProbeNotFound, ProbeStateRefused } from "./errors.ts";
import {
  type DraftFailure,
  GuardAdmitted,
  GuardRetired,
  ProbeDiscarded,
  ProbeDrafted,
  ProbeRan,
} from "./events.ts";
import {
  ADMISSION_RUNS,
  admit,
  MAX_DRAFT_ATTEMPTS,
  type Probe,
  type ProbeCell,
  type ProbeOutcome,
} from "./probe.ts";

/** The events the owning DO commits for one probe, and the guard it may become. */
export const ProbeEvent = Schema.Union([
  ProbeDrafted,
  ProbeRan,
  ProbeDiscarded,
  GuardAdmitted,
  GuardRetired,
]);
export type ProbeEvent = typeof ProbeEvent.Type;

export type ProbeCommand =
  /** A draft compiled and ran, after `attempts` tries of the bounded repair loop. */
  | {
      readonly _tag: "Draft";
      readonly conflictId: ConflictId;
      readonly attempts: number;
      readonly bundleHash: ContentHash;
    }
  /** Every draft failed: the probe begins and ends discarded, and its conflict is unprovable. */
  | {
      readonly _tag: "DraftFailed";
      readonly conflictId: ConflictId;
      /** Why, carried onto ProbeDiscarded. */
      readonly detail?: DraftFailure;
    }
  /** One world-matrix cell completed. `guardId` names the guard the probe becomes if this cell admits it. */
  | {
      readonly _tag: "Record";
      readonly world: World;
      readonly run: number;
      readonly outcome: ProbeOutcome;
      readonly resultRef: string;
      readonly guardId: GuardId;
    }
  /**
   * The probe's run ended, for any cause, with admission still pending: the
   * Workflow or a world died after the draft was recorded, or every cell the
   * run had was recorded and fewer than three runs were complete. No more
   * cells are coming, which only the caller knows. The probe is discarded
   * `run-failed`, and its conflict is unprovable.
   */
  | { readonly _tag: "RunFailed" }
  /** A superseding Decision retires the guard. */
  | { readonly _tag: "Retire"; readonly decisionId: DecisionId };

/**
 * Facts from I/O: the time, the probe this decision is about, and its
 * conflict as the owning DO holds it. The conflict folds `ProbeDrafted` and
 * `ProbeRan`, so a probe drafts only for a Suspected conflict with no probe,
 * and records cells only while that conflict is Probing it.
 */
export interface ProbeFacts {
  readonly now: Instant;
  readonly probeId: ProbeId;
  readonly conflict?: Conflict;
}

export type ProbeRejection = ProbeNotFound | ProbeStateRefused;

type Decision = Result.Result<readonly ProbeEvent[], ProbeRejection>;

const readFirst: NextAction = {
  kind: "read",
  title: "Read the probe: its state decides which command applies",
};
const redraft: NextAction = {
  kind: "escalate",
  title: `Escalate the conflict as unprovable: a probe gets at most ${MAX_DRAFT_ATTEMPTS} drafts`,
};

/** Whether the conflict names the premise at stake and the effect against it: what a probe drafts against. */
const probeable = (conflict: Conflict | undefined): boolean =>
  conflict?.premise !== undefined && conflict.effect !== undefined;

const unguessed: NextAction = {
  kind: "escalate",
  title:
    "Report the draft failed: the conflict names no premise and effect to probe, so it escalates as unprovable",
};

const awaitsDraft = (conflict: Conflict | undefined, conflictId: ConflictId): boolean =>
  conflict !== undefined &&
  conflict.id === conflictId &&
  conflict.state === "suspected" &&
  conflict.probeId === undefined;

const sameCell = (a: ProbeCell, b: { readonly world: World; readonly run: number }): boolean =>
  a.world === b.world && a.run === b.run;

/**
 * Decides a command on a probe (docs/domain/state-machines.md § Probe → Guard).
 * Each recorded cell is checked against `admit`: the cell that lets three
 * complete runs discriminate admits the guard, and the cell that shows the
 * probe does not discriminate, or not every time, discards it. Until then it
 * calibrates.
 */
export const decideProbe = (
  state: Probe | undefined,
  command: ProbeCommand,
  facts: ProbeFacts,
): Decision => {
  if (state === undefined) {
    if (
      (command._tag === "Draft" || command._tag === "DraftFailed") &&
      !awaitsDraft(facts.conflict, command.conflictId)
    )
      return Result.fail(
        new ProbeStateRefused({
          probeId: facts.probeId,
          command: command._tag,
          reason: "conflict-not-awaiting-a-probe",
          nextActions: [readFirst],
        }),
      );
    if (command._tag === "Draft" && !probeable(facts.conflict))
      return Result.fail(
        new ProbeStateRefused({
          probeId: facts.probeId,
          command: command._tag,
          reason: "no-propositions",
          nextActions: [unguessed],
        }),
      );
    switch (command._tag) {
      case "Draft":
        return Number.isInteger(command.attempts) &&
          command.attempts >= 1 &&
          command.attempts <= MAX_DRAFT_ATTEMPTS
          ? Result.succeed([
              ProbeDrafted.make({
                probeId: facts.probeId,
                conflictId: command.conflictId,
                attempts: command.attempts,
                bundleHash: command.bundleHash,
              }),
            ])
          : Result.fail(
              new ProbeStateRefused({
                probeId: facts.probeId,
                command: command._tag,
                reason: "attempts-out-of-range",
                nextActions: [redraft],
              }),
            );
      case "DraftFailed":
        return Result.succeed([
          ProbeDiscarded.make({
            probeId: facts.probeId,
            reason: "draft-failed",
            conflictId: command.conflictId,
            ...(command.detail === undefined ? {} : { detail: command.detail }),
          }),
        ]);
      default:
        return Result.fail(new ProbeNotFound({ probeId: facts.probeId }));
    }
  }
  const probe = state;
  const refuse = (reason?: string): Decision =>
    Result.fail(
      new ProbeStateRefused({
        probeId: probe.id,
        state: probe.state,
        command: command._tag,
        ...(reason === undefined ? {} : { reason }),
        nextActions: [readFirst],
      }),
    );
  switch (command._tag) {
    case "Draft":
    case "DraftFailed":
      return refuse();
    case "Record": {
      if (probe.state !== "calibrating") return refuse();
      const conflict = facts.conflict;
      if (conflict?.state !== "probing" || conflict.probeId !== probe.id)
        return refuse("conflict-not-probing");
      if (!Number.isInteger(command.run) || command.run < 1 || command.run > ADMISSION_RUNS)
        return refuse("run-out-of-range");
      const known = probe.cells.find((c) => sameCell(c, command));
      // A retried step reports the same cell again: nothing to commit. A different answer is not a retry.
      if (known !== undefined)
        return known.outcome === command.outcome ? Result.succeed([]) : refuse("cell-contradicts");
      const ran = ProbeRan.make({
        probeId: probe.id,
        conflictId: probe.conflictId,
        world: command.world,
        run: command.run,
        outcome: command.outcome,
        resultRef: command.resultRef,
      });
      const admission = admit([
        ...probe.cells,
        { world: command.world, run: command.run, outcome: command.outcome },
      ]);
      switch (admission._tag) {
        case "pending":
          return Result.succeed([ran]);
        case "admitted":
          return Result.succeed([
            ran,
            GuardAdmitted.make({
              guardId: command.guardId,
              probeId: probe.id,
              conflictId: probe.conflictId,
              runs: admission.runs,
            }),
          ]);
        case "rejected":
          return Result.succeed([
            ran,
            ProbeDiscarded.make({
              probeId: probe.id,
              reason: admission.reason,
              conflictId: probe.conflictId,
            }),
          ]);
        default: {
          const unreachable: never = admission;
          return unreachable;
        }
      }
    }
    case "RunFailed": {
      if (probe.state !== "calibrating") return refuse();
      const conflict = facts.conflict;
      if (conflict?.state !== "probing" || conflict.probeId !== probe.id)
        return refuse("conflict-not-probing");
      return Result.succeed([
        ProbeDiscarded.make({
          probeId: probe.id,
          reason: "run-failed",
          conflictId: probe.conflictId,
        }),
      ]);
    }
    case "Retire":
      return probe.state === "admitted" && probe.guardId !== undefined
        ? Result.succeed([
            GuardRetired.make({ guardId: probe.guardId, decisionId: command.decisionId }),
          ])
        : refuse();
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Probe | undefined, event: ProbeEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a probe ${state === undefined ? "not yet drafted" : state.state}`,
  );
};

/**
 * Folds one committed event into the probe, with its own from-table; anything
 * else throws `IllegalTransition`. Admission and discard are checked against
 * `admit` over the cells folded so far, so a log cannot admit a probe the
 * matrix does not.
 */
export const evolveProbe = (state: Probe | undefined, committed: Committed<ProbeEvent>): Probe => {
  const event = committed.payload;
  if (state === undefined) {
    if (event._tag === "ProbeDrafted")
      return {
        id: event.probeId,
        conflictId: event.conflictId,
        state: "calibrating",
        attempts: event.attempts,
        bundleHash: event.bundleHash,
        cells: [],
        createdAt: committed.at,
      };
    return event._tag === "ProbeDiscarded" &&
      event.reason === "draft-failed" &&
      event.conflictId !== undefined
      ? {
          id: event.probeId,
          conflictId: event.conflictId,
          state: "discarded",
          cells: [],
          discarded: "draft-failed",
          createdAt: committed.at,
        }
      : illegal(state, event);
  }
  const probe = state;
  switch (event._tag) {
    case "ProbeDrafted":
      return illegal(probe, event);
    case "ProbeRan":
      return probe.state === "calibrating" &&
        event.probeId === probe.id &&
        event.conflictId === probe.conflictId &&
        !probe.cells.some((c) => sameCell(c, event))
        ? {
            ...probe,
            cells: [...probe.cells, { world: event.world, run: event.run, outcome: event.outcome }],
          }
        : illegal(probe, event);
    case "GuardAdmitted":
      return probe.state === "calibrating" &&
        event.probeId === probe.id &&
        admit(probe.cells)._tag === "admitted"
        ? { ...probe, state: "admitted", guardId: event.guardId }
        : illegal(probe, event);
    case "ProbeDiscarded": {
      const admission = admit(probe.cells);
      // A run that failed ends a probe whose matrix has decided nothing.
      if (event.reason === "run-failed")
        return probe.state === "calibrating" &&
          event.probeId === probe.id &&
          admission._tag === "pending"
          ? { ...probe, state: "discarded", discarded: event.reason }
          : illegal(probe, event);
      return probe.state === "calibrating" &&
        event.probeId === probe.id &&
        admission._tag === "rejected" &&
        admission.reason === event.reason
        ? { ...probe, state: "discarded", discarded: event.reason }
        : illegal(probe, event);
    }
    case "GuardRetired":
      return probe.state === "admitted" && event.guardId === probe.guardId
        ? { ...probe, state: "retired", retiredBy: event.decisionId }
        : illegal(probe, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a probe from its events in `seq` order. */
export const replayProbe = (events: readonly Committed<ProbeEvent>[]): Probe | undefined =>
  events.reduce<Probe | undefined>((state, event) => evolveProbe(state, event), undefined);
