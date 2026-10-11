// Every event Keel publishes, as the console reads it.
//
// The payloads are Keel's own: `KeelEvent` in its generated wire types
// (./keel), one interface per event, told apart by `_tag`. Nothing about a
// published payload is written here. Two things are laid over them.
//
//   Ahead   What Keel's design settles and Keel has not built yet. `StillAhead`, at the end of this file, compiles only while
//           each is still missing from Keel's contract: the day Keel builds
//           one, typecheck fails there, and the console is made to read what
//           was built.
//   x       What the console needs that nobody has decided yet. Declared in
//           provisional.ts, listed in QUESTIONS.md, and never read without a
//           fallback.

import type { EventType, KeelEvent } from "./envelope.ts";
import type * as Keel from "./keel/index.ts";
import type { PlanSpec, ProvisionalFields } from "./provisional.ts";

type Published = Keel.KeelEvent;
type PublishedType = Published["_tag"];
type Of<Type extends PublishedType> = Extract<Published, { _tag: Type }>;

// The vocabulary the console shares with Keel is Keel's.
export type {
  AgentKind,
  ConflictKind,
  DriftClass,
  EscalationOption,
  Move,
  Scope,
} from "./keel/index.ts";
/** What kind of judgement a question asks for. */
export type EscalationCategory = Keel.EscalationRaised["category"];
/** A world a probe runs in. `A-noop` is the premise holder's world with the premised behaviour removed. */
export type ProbeWorld = Keel.World;
export type ProbeOutcome = Keel.ProbeRan["outcome"];
export type DriftEntry = Keel.Drift;
/** How a conflict was proven. The proof matches the conflict's kind. */
export type ConflictProof = Keel.ConflictProven["evidence"];
export type PrecedentRef = Keel.EventPrecedentRef;
export type Neighbour = Keel.EventNeighbour;
export type Contradiction = Keel.EventContradiction;
export type NextAction = Keel.EventNextAction;

/** What is decided and not built, by event. Each entry replaces the fields of Keel's payload that it names. */
interface Ahead {
  /**
   * A1: `steps` is to be the plan itself, as the flow it was compiled to. Keel commits only how many steps
   * there are today, so the console takes either and draws a plan only when it is given one.
   */
  PlanCompiled: { steps: PlanSpec | number };
}

type Laid<Type extends PublishedType> = Type extends keyof Ahead
  ? Omit<Of<Type>, keyof Ahead[Type]> & Ahead[Type]
  : Of<Type>;

/** Every event's payload, by its name. */
export type PayloadMap = { [Type in PublishedType]: Laid<Type> };

/** One event of a known type. `x` holds anything the console needs that nobody has decided yet. */
export type EventOf<Type extends EventType> = KeelEvent<
  Type,
  PayloadMap[Type] & { x?: Type extends keyof ProvisionalFields ? ProvisionalFields[Type] : never }
>;

/** Any catalogue event, discriminated by `type`. */
export type AnyEvent = { [Type in EventType]: EventOf<Type> }[EventType];

type Assert<Holds extends true> = Holds;

/**
 * Compiles only while everything in `Ahead` is still ahead of Keel. When Keel builds one of these, its line
 * fails: take it out of `Ahead`, and make the console read the shape Keel built.
 */
export type StillAhead = [
  Assert<Of<"PlanCompiled">["steps"] extends number ? true : false>,
  // A3: one sentence from whoever produced a piece of evidence.
  Assert<"summary" extends keyof Keel.Evidence ? false : true>,
];
