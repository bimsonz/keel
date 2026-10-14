import { Schema } from "effect";
import { ChangeId, DecisionId, InstantSchema } from "../kernel/index.ts";
import { type Intent, Suggestion } from "./change.ts";
import { compare } from "./compare.ts";
import { Proposition, SubjectKey } from "./proposition.ts";

/** Another change near this one. Footprint overlap is exposure: it never opens a conflict. */
export const Neighbour = Schema.Struct({
  changeId: ChangeId,
  goal: Schema.String,
  subjects: Schema.Array(SubjectKey),
  overlap: Schema.Literals(["subject", "footprint"]),
});
export type Neighbour = typeof Neighbour.Type;

/** What the contradicting proposition is to the change holding it: something it relies on, or something it alters. */
export const ContradictionRole = Schema.Literals(["premise", "effect"]);
export type ContradictionRole = typeof ContradictionRole.Type;

export const Contradiction = Schema.Struct({
  premise: Proposition,
  with: Proposition,
  /** The change or tenet holding the premise. */
  holder: Schema.String,
  /** Whether `with` is a premise or an effect. Exposure always sets it; absent (older events) reads as an effect. */
  withRole: Schema.optional(ContradictionRole),
});
export type Contradiction = typeof Contradiction.Type;

export const PrecedentRef = Schema.Struct({
  decisionId: DecisionId,
  summary: Schema.String,
  decidedAt: InstantSchema,
  scope: Schema.optional(Schema.String),
});
export type PrecedentRef = typeof PrecedentRef.Type;

/** What a suggested move rests on: a contradiction in the same preflight, by its index, or a precedent. */
export const MoveBasis = Schema.Union([
  Schema.TaggedStruct("contradiction", {
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.TaggedStruct("precedent", { decisionId: DecisionId }),
]);
export type MoveBasis = typeof MoveBasis.Type;

export const Preflight = Schema.Struct({
  neighbours: Schema.Array(Neighbour),
  contradictions: Schema.Array(Contradiction),
  precedents: Schema.Array(PrecedentRef),
  suggestedMove: Suggestion,
  /** What the move rests on; absent exactly when the move is `proceed`. */
  basis: Schema.optional(MoveBasis),
  /** The live changes with the same intent, as exposure listed them, never ranked. Absent when there are none; the move never reads them. */
  alternatives: Schema.optional(Schema.Array(ChangeId)),
});
export type Preflight = typeof Preflight.Type;

/**
 * A precedent the Subject DO matched to the change by scope, with what its
 * decision upheld: the propositions taken from the decided conflict. A
 * precedent that upheld nothing typed can be followed but never contradicted.
 */
export type ScopedPrecedent = {
  readonly ref: PrecedentRef;
  readonly holds: readonly Proposition[];
};

const isMust = (p: Proposition): boolean => (p.strength ?? "must") === "must";

/** Whether the intent contradicts a proposition the decision upheld: a premise it breaks, or an effect it can't rely on. */
const contradictsPrecedent = (intent: Intent, precedent: ScopedPrecedent): boolean =>
  precedent.holds.some(
    (held) =>
      intent.premises.some((p) => compare(p, held).outcome === "contradicts") ||
      (intent.declaredEffects ?? []).some((e) => compare(held, e).outcome === "contradicts"),
  );

const cites = (index: number): MoveBasis => ({ _tag: "contradiction", index });

/**
 * Preflight's suggested move: the first rule
 * that matches wins, ordered by who breaks whom.
 * 1. Your effect contradicts a live change's must premise: `refine`, or you break them.
 * 2. A live change's effect contradicts your must premise: `sequence`, since
 *    what you rely on is about to change.
 * 3. Your intent contradicts a precedent in scope: `distinguish`.
 * 4. Any other contradiction (a should premise, or two premises, where
 *    neither change alters anything): `coordinate`.
 * 5. Otherwise `proceed`. A neighbour alone is proceed: overlap isn't conflict.
 * Each move cites the earliest contradiction or precedent it rests on.
 * `merge`, `yield` and `escalate` are not suggested yet. Unreadable
 * propositions stay notices and never move. Alternatives (live changes with
 * the same intent) are copied from exposure as they are: they inform, and
 * neither the move nor what it cites reads them.
 */
export const preflight = (
  self: ChangeId,
  intent: Intent,
  exposure: {
    readonly neighbours: readonly Neighbour[];
    readonly contradictions: readonly Contradiction[];
    readonly alternatives?: readonly ChangeId[];
  },
  precedents: readonly ScopedPrecedent[],
): Preflight => {
  const { neighbours, contradictions, alternatives = [] } = exposure;
  const listed = {
    neighbours,
    contradictions,
    precedents: precedents.map((p) => p.ref),
    ...(alternatives.length === 0 ? {} : { alternatives }),
  };
  const breaks = contradictions.findIndex((c) => c.holder !== self && isMust(c.premise));
  if (breaks !== -1) return { ...listed, suggestedMove: "refine", basis: cites(breaks) };
  const broken = contradictions.findIndex(
    (c) => c.holder === self && (c.withRole ?? "effect") === "effect" && isMust(c.premise),
  );
  if (broken !== -1) return { ...listed, suggestedMove: "sequence", basis: cites(broken) };
  const decided = precedents.find((p) => contradictsPrecedent(intent, p));
  if (decided !== undefined)
    return {
      ...listed,
      suggestedMove: "distinguish",
      basis: { _tag: "precedent", decisionId: decided.ref.decisionId },
    };
  if (contradictions.length > 0) return { ...listed, suggestedMove: "coordinate", basis: cites(0) };
  return { ...listed, suggestedMove: "proceed" };
};
