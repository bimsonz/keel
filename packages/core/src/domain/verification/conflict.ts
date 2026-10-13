import { Schema } from "effect";
import {
  ChangeId,
  ConflictId,
  DecisionId,
  EscalationId,
  EvidenceClass,
  InstantSchema,
  ProbeId,
  SubjectId,
  TenetId,
} from "../kernel/index.ts";
import {
  DerivationMethod,
  type JudgedEffect,
  Move,
  Predicate,
  Proposition,
  SubjectKey,
} from "../coordination/index.ts";

/** Footprint overlap is not a kind: proximity is exposure and never opens a conflict. */
/**
 * The premise a semantic conflict puts at stake, and the change holding it: what
 * a probe drafts against. A conflict without it is escalated as unprovable,
 * never guessed.
 */
export const SuspectPremise = Schema.Struct({ holder: ChangeId, proposition: Proposition });
export type SuspectPremise = typeof SuspectPremise.Type;

/** The evidence class each derivation method gives, as on a DerivedEffect. */
const CLASS_OF: Readonly<Record<DerivationMethod, EvidenceClass>> = {
  extractor: "ruling",
  clef: "opinion",
  "code-model": "opinion",
};

/**
 * How a suspect effect is known, as fallout judged it. With no method it is
 * the agent's own claim: declared, and testimony. With a method Keel derived
 * it, and the method fixes the evidence class as it does on a DerivedEffect:
 * an extractor rules, a model has an opinion. `declared` then says whether the
 * agent's declared effects spoke for what Keel derived.
 */
export const SuspectEvidence = Schema.Struct({
  declared: Schema.Boolean,
  method: Schema.optional(DerivationMethod),
  evidenceClass: EvidenceClass,
}).check(
  Schema.makeFilter(
    (e) =>
      (e.method === undefined
        ? e.declared && e.evidenceClass === "testimony"
        : e.evidenceClass === CLASS_OF[e.method]) ||
      "an effect with no method is its agent's declared testimony; a method fixes the evidence class",
  ),
);
export type SuspectEvidence = typeof SuspectEvidence.Type;

/** The evidence of an effect as fallout judged it: what a ConflictSuspected says of its effect. */
export const suspectEvidence = (judged: JudgedEffect): SuspectEvidence =>
  judged.method === "declared"
    ? { declared: true, evidenceClass: "testimony" }
    : { declared: judged.declared, method: judged.method, evidenceClass: judged.evidenceClass };

/** The effect that contradicts the premise, and the change making it. */
export const SuspectEffect = Schema.Struct({
  changeId: ChangeId,
  proposition: Proposition,
  /** How the effect is known. Absent on events older than the field. */
  evidence: Schema.optional(SuspectEvidence),
});
export type SuspectEffect = typeof SuspectEffect.Type;

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

export const Conflict = Schema.Struct({
  id: ConflictId,
  kind: ConflictKind,
  state: ConflictState,
  parties: Schema.Array(Party),
  /** Present for semantic and precedent conflicts, which the Subject DO owns. */
  subjectId: Schema.optional(SubjectId),
  /** That subject's key, when the suspicion gave it: what addresses its Subject DO. */
  subjectKey: Schema.optional(SubjectKey),
  predicate: Schema.optional(Predicate),
  openedAt: InstantSchema,
  /** Absent means `fallout`. */
  origin: Schema.optional(ConflictOrigin),
  /** The premise at stake and the effect against it: a probe is drafted only when both are known. */
  premise: Schema.optional(SuspectPremise),
  effect: Schema.optional(SuspectEffect),
  /** The probe drafted for it, from `ProbeDrafted` on. */
  probeId: Schema.optional(ProbeId),
  escalationId: Schema.optional(EscalationId),
  /** The Move that resolved it, and the Decision when a ruling did. */
  move: Schema.optional(Move),
  decisionId: Schema.optional(DecisionId),
  /** The parties the ruling went against: each bounces, where every other party resumes. Absent when it favoured no side. */
  against: Schema.optional(Schema.Array(ChangeId)),
  /** The suite cells of its world matrix (`WorldCheckRan`), in the order they were recorded. */
  checks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        world: World,
        check: Schema.String,
        run: Schema.Int,
        outcome: Schema.Literals(["pass", "fail", "n/a"]),
      }),
    ),
  ),
});
export type Conflict = typeof Conflict.Type;

/**
 * The changes a ruling goes against, by the side it lets stand: the premise
 * standing goes against the change that makes the effect, and the effect
 * standing goes against the change that holds the premise. A ruling is between
 * two sides, so a conflict that does not name both, or names one change on
 * both, has no one to go against.
 */
export const sidesAgainst = (
  conflict: Conflict,
  stands: "premise" | "effect",
): readonly ChangeId[] => {
  const holder = conflict.premise?.holder;
  const author = conflict.effect?.changeId;
  if (holder === undefined || author === undefined || holder === author) return [];
  return [stands === "premise" ? author : holder];
};
