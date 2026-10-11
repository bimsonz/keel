import { Array as Arr, Result, Schema } from "effect";
import type { Predicate } from "../coordination/index.ts";
import {
  type ChangeId,
  type Committed,
  type ConflictId,
  type DecisionId,
  type GuardId,
  IllegalTransition,
  type Instant,
  type NextAction,
  type SubjectId,
  type TenetId,
} from "../kernel/index.ts";
import { TenetStateRefused } from "./errors.ts";
import {
  TenetContested,
  TenetEstablished,
  TenetReaffirmed,
  TenetRetracted,
  TenetSuperseded,
} from "./events.ts";
import type { Tenet } from "./memory.ts";

/** The events the Subject DO commits for one tenet. */
export const TenetEvent = Schema.Union([
  TenetEstablished,
  TenetContested,
  TenetReaffirmed,
  TenetRetracted,
  TenetSuperseded,
]);
export type TenetEvent = typeof TenetEvent.Type;

/**
 * What a proven conflict against a predicate's tenet does, as the project
 * composed its beliefs for the change (ADR 0005, decided 11 Oct): `block`
 * holds the challenger for a ruling, `advise` warns both agents and offers the
 * proving test, `annotate` only records it. A tenet never blocks by itself.
 */
export const BeliefPolicy = Schema.Literals(["block", "advise", "annotate"]);
export type BeliefPolicy = typeof BeliefPolicy.Type;

/** The policy when the project names none. */
export const DEFAULT_BELIEF_POLICY: BeliefPolicy = "advise";

/**
 * What the Tenet machine reads of a conflict, looked up by the owning DO.
 * Verification's `Conflict` state has this shape.
 */
export interface ConflictFacts {
  readonly id: ConflictId;
  readonly state: string;
  readonly parties: readonly string[];
  readonly move?: string | undefined;
}

export type TenetCommand =
  /** A landed effect, backed by the guards admitted for it, becomes a tenet. */
  | {
      readonly _tag: "Establish";
      readonly subjectId: SubjectId;
      readonly predicate: Predicate;
      readonly value: string | number | boolean;
      readonly changeId: ChangeId;
      readonly guardIds: readonly GuardId[];
    }
  /** An open conflict (`facts.conflict`) names the tenet as a party. */
  | { readonly _tag: "Contest"; readonly conflictId: ConflictId }
  /** The contesting conflict (`facts.conflict`) settled in the tenet's favour. */
  | { readonly _tag: "Reaffirm"; readonly conflictId: ConflictId }
  /** `changeId` landed against the tenet: on a ruling, or on proof where the policy let it land. */
  | { readonly _tag: "Retract"; readonly changeId: ChangeId; readonly decisionId?: DecisionId }
  /** A new tenet on the same `(subject, predicate)` replaces it. */
  | { readonly _tag: "Supersede"; readonly by: TenetId };

export interface TenetFacts {
  readonly now: Instant;
  readonly tenetId: TenetId;
  readonly conflict?: ConflictFacts;
  /** The predicate's policy, from the beliefs composed for the change; absent is `advise`. */
  readonly policy?: BeliefPolicy;
}

export type TenetRejection = TenetStateRefused;

type Outcome = Result.Result<readonly TenetEvent[], TenetRejection>;

/** A conflict still deciding: it can contest a tenet. */
const OPEN = new Set(["suspected", "probing", "proven", "escalated"]);
/** Moves by which a resolved conflict leaves the tenet standing (R5). */
const IN_FAVOUR = new Set(["distinguish", "yield"]);

const readConflict: NextAction = {
  kind: "read",
  title: "Read the conflict contesting the tenet",
  operationId: "Conflicts_getConflict",
};
const readEscalations: NextAction = {
  kind: "read",
  title: "List the escalations, to find the ruling this needs",
  operationId: "Operator_listEscalations",
};

const settledInFavour = (conflict: ConflictFacts): boolean =>
  conflict.state === "dismissed" ||
  (conflict.state === "resolved" && conflict.move !== undefined && IN_FAVOUR.has(conflict.move));

/**
 * Decides a command on a tenet (docs/domain/state-machines.md § Tenet). Only
 * retraction reads the policy: under `block` a tenet is retracted only on a
 * ruling; under `advise` or `annotate` a proven conflict whose party landed
 * retracts it too, citing the conflict. Opinion never retracts one.
 */
export const decideTenet = (
  state: Tenet | undefined,
  command: TenetCommand,
  facts: TenetFacts,
): Outcome => {
  const refuse = (reason?: string, next: NextAction = readConflict): Outcome =>
    Result.fail(
      new TenetStateRefused({
        tenetId: state?.id ?? facts.tenetId,
        ...(state === undefined ? {} : { state: state.state }),
        command: command._tag,
        ...(reason === undefined ? {} : { reason }),
        nextActions: [next],
      }),
    );
  const conflict = facts.conflict;
  if (state === undefined) {
    if (command._tag !== "Establish") return refuse();
    const guardIds = command.guardIds;
    if (!Arr.isReadonlyArrayNonEmpty(guardIds)) return refuse("unguarded");
    return Result.succeed([
      TenetEstablished.make({
        tenetId: facts.tenetId,
        subjectId: command.subjectId,
        predicate: command.predicate,
        value: command.value,
        changeId: command.changeId,
        guardIds,
      }),
    ]);
  }
  const tenet = state;
  switch (command._tag) {
    case "Establish":
      return refuse();
    case "Contest":
      if (tenet.state !== "established") return refuse();
      return conflict?.id === command.conflictId &&
        OPEN.has(conflict.state) &&
        conflict.parties.includes(tenet.id)
        ? Result.succeed([
            TenetContested.make({ tenetId: tenet.id, conflictId: command.conflictId }),
          ])
        : refuse("conflict-not-against-tenet");
    case "Reaffirm":
      if (tenet.state !== "contested") return refuse();
      return command.conflictId === tenet.conflictId &&
        conflict?.id === command.conflictId &&
        settledInFavour(conflict)
        ? Result.succeed([
            TenetReaffirmed.make({ tenetId: tenet.id, conflictId: command.conflictId }),
          ])
        : refuse("conflict-unsettled");
    case "Retract": {
      const contesting = tenet.conflictId;
      if (tenet.state !== "contested" || contesting === undefined) return refuse();
      if (command.decisionId !== undefined)
        return Result.succeed([
          TenetRetracted.make({
            tenetId: tenet.id,
            changeId: command.changeId,
            conflictId: contesting,
            decisionId: command.decisionId,
          }),
        ]);
      if ((facts.policy ?? DEFAULT_BELIEF_POLICY) === "block")
        return refuse("ruling-required", readEscalations);
      return conflict?.id === contesting &&
        conflict.state === "proven" &&
        conflict.parties.includes(command.changeId)
        ? Result.succeed([
            TenetRetracted.make({
              tenetId: tenet.id,
              changeId: command.changeId,
              conflictId: contesting,
            }),
          ])
        : refuse("not-proven");
    }
    case "Supersede":
      return tenet.state === "established" && command.by !== tenet.id
        ? Result.succeed([TenetSuperseded.make({ tenetId: tenet.id, by: command.by })])
        : refuse();
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Tenet | undefined, event: TenetEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a tenet ${state === undefined ? "not yet established" : state.state}`,
  );
};

/** Folds one committed event into the tenet, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveTenet = (state: Tenet | undefined, committed: Committed<TenetEvent>): Tenet => {
  const event = committed.payload;
  if (state === undefined) {
    if (event._tag !== "TenetEstablished") return illegal(state, event);
    const guards = event.guardIds;
    return Arr.isReadonlyArrayNonEmpty(guards)
      ? {
          id: event.tenetId,
          subjectId: event.subjectId,
          predicate: event.predicate,
          value: event.value,
          guards,
          state: "established",
        }
      : illegal(state, event);
  }
  const tenet = state;
  if (event.tenetId !== tenet.id) return illegal(tenet, event);
  switch (event._tag) {
    case "TenetEstablished":
      return illegal(tenet, event);
    case "TenetContested":
      return tenet.state === "established"
        ? { ...tenet, state: "contested", conflictId: event.conflictId }
        : illegal(tenet, event);
    case "TenetReaffirmed": {
      if (tenet.state !== "contested" || event.conflictId !== tenet.conflictId)
        return illegal(tenet, event);
      const { conflictId: _settled, ...standing } = tenet;
      return { ...standing, state: "established" };
    }
    case "TenetRetracted":
      return tenet.state === "contested" && event.conflictId === tenet.conflictId
        ? {
            ...tenet,
            state: "retracted",
            endedBy: event.changeId,
            ...(event.decisionId === undefined ? {} : { decisionId: event.decisionId }),
          }
        : illegal(tenet, event);
    case "TenetSuperseded":
      return tenet.state === "established"
        ? { ...tenet, state: "superseded", endedBy: event.by }
        : illegal(tenet, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a tenet from its events in `seq` order. */
export const replayTenet = (events: readonly Committed<TenetEvent>[]): Tenet | undefined =>
  events.reduce<Tenet | undefined>((state, event) => evolveTenet(state, event), undefined);
