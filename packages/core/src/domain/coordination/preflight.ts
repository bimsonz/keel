import { Schema } from "effect";
import { ChangeId, DecisionId, InstantSchema } from "../kernel/index.ts";
import { Move } from "./change.ts";
import { Proposition, SubjectKey } from "./proposition.ts";

/** Another change near this one. Footprint overlap is exposure: it never opens a conflict. */
export const Neighbour = Schema.Struct({
  changeId: ChangeId,
  goal: Schema.String,
  subjects: Schema.Array(SubjectKey),
  overlap: Schema.Literals(["subject", "footprint"]),
});
export type Neighbour = typeof Neighbour.Type;

export const Contradiction = Schema.Struct({
  premise: Proposition,
  with: Proposition,
  holder: Schema.String,
});
export type Contradiction = typeof Contradiction.Type;

export const PrecedentRef = Schema.Struct({
  decisionId: DecisionId,
  summary: Schema.String,
  decidedAt: InstantSchema,
  scope: Schema.optional(Schema.String),
});
export type PrecedentRef = typeof PrecedentRef.Type;

export const Preflight = Schema.Struct({
  neighbours: Schema.Array(Neighbour),
  contradictions: Schema.Array(Contradiction),
  precedents: Schema.Array(PrecedentRef),
  suggestedMove: Move,
});
export type Preflight = typeof Preflight.Type;
