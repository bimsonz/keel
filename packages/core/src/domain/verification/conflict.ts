import { Schema } from "effect";
import { ChangeId, ConflictId, InstantSchema, SubjectId, TenetId } from "../kernel/index.ts";
import { Predicate } from "../coordination/index.ts";

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

export const Conflict = Schema.Struct({
  id: ConflictId,
  kind: ConflictKind,
  state: ConflictState,
  parties: Schema.Array(Party),
  /** Present for semantic and precedent conflicts, which the Subject DO owns. */
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
  openedAt: InstantSchema,
});
export type Conflict = typeof Conflict.Type;

/** One combination of changes evaluated together. */
export const World = Schema.Literals(["trunk", "A", "B", "AB"]);
export type World = typeof World.Type;

export const ProbeState = Schema.Literals(["calibrating", "admitted", "discarded", "retired"]);
export type ProbeState = typeof ProbeState.Type;
