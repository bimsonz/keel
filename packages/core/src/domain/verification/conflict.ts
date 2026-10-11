import { Schema } from "effect";
import {
  ChangeId,
  ConflictId,
  DecisionId,
  EscalationId,
  InstantSchema,
  ProbeId,
  SubjectId,
  TenetId,
} from "../kernel/index.ts";
import { Move, Predicate } from "../coordination/index.ts";

/** Footprint overlap is not a kind: proximity is exposure and never opens a conflict. */
export const ConflictKind = Schema.Literals(["textual", "semantic", "precedent", "interaction"]);
export type ConflictKind = typeof ConflictKind.Type;

export const ConflictState = Schema.Literals([
  "suspected",
  "probing",
  "proven",
  "dismissed",
  "escalated",
  "resolved",
]);
export type ConflictState = typeof ConflictState.Type;

export const Party = Schema.Union([ChangeId, TenetId]);
export type Party = typeof Party.Type;

/**
 * Who raised the suspicion: `fallout` from derived facts, or `opinion` from a
 * decision model. An opinion-raised conflict is tainted, so no lattice
 * comparison over it counts as a ruling: only its probe or a person settles it.
 */
export const ConflictOrigin = Schema.Literals(["fallout", "opinion"]);
export type ConflictOrigin = typeof ConflictOrigin.Type;

export const Conflict = Schema.Struct({
  id: ConflictId,
  kind: ConflictKind,
  state: ConflictState,
  parties: Schema.Array(Party),
  /** Present for semantic and precedent conflicts, which the Subject DO owns. */
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
  openedAt: InstantSchema,
  /** Absent means `fallout`. */
  origin: Schema.optional(ConflictOrigin),
  /** The probe drafted for it, from `ProbeDrafted` on. */
  probeId: Schema.optional(ProbeId),
  escalationId: Schema.optional(EscalationId),
  /** The Move that resolved it, and the Decision when a ruling did. */
  move: Schema.optional(Move),
  decisionId: Schema.optional(DecisionId),
});
export type Conflict = typeof Conflict.Type;

/** One combination of changes evaluated together, as a flow can run steps over it. */
export const FlowWorld = Schema.Literals(["trunk", "A", "B", "AB"]);
export type FlowWorld = typeof FlowWorld.Type;

/**
 * A world a probe runs in: a flow's worlds, plus `A-noop`, the
 * premise-holder's world with the premised behaviour removed (for S-1's
 * freshness template, a revoke route that answers 204 and removes nothing).
 * The probe's template supplies the recipe for building it, so no flow step
 * runs there. A probe that passes there does not test the premise, so it is
 * never admitted.
 */
export const World = Schema.Literals(["trunk", "A", "B", "AB", "A-noop"]);
export type World = typeof World.Type;
