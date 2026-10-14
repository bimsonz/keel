// Every event Keel publishes, as the console reads it.
//
// The payloads are Keel's own: `KeelEvent` in its generated wire types
// (./keel), one interface per event, told apart by `_tag`. Nothing about a
// published payload is written here. One thing is laid over them.
//
//   x       What the console needs that nobody has decided yet. Declared in
//           provisional.ts, and never read without a fallback.

import type { EventType, KeelEvent } from "./envelope.ts";
import type * as Keel from "./keel/index.ts";
import type { ProvisionalFields } from "./provisional.ts";

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

/** Every event's payload, by its name. */
export type PayloadMap = { [Type in PublishedType]: Of<Type> };

/** One event of a known type. `x` holds anything the console needs that nobody has decided yet. */
export type EventOf<Type extends EventType> = KeelEvent<
  Type,
  PayloadMap[Type] & { x?: Type extends keyof ProvisionalFields ? ProvisionalFields[Type] : never }
>;

/** Any catalogue event, discriminated by `type`. */
export type AnyEvent = { [Type in EventType]: EventOf<Type> }[EventType];
