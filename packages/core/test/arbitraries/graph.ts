import type {
  DerivedEffect,
  FootprintEntry,
  GuardedTenet,
  HeldPremise,
  Intent,
  LiveChange,
  Predicate,
  Proposition,
} from "../../src/domain/coordination/index.ts";
import { type ChangeId, EvidenceClass, Glob, makeId } from "../../src/domain/kernel/index.ts";
import { fc } from "../support/fast-check.ts";
import { propositionArb } from "./coordination.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");

export const changeIds: readonly ChangeId[] = [1, 2, 3, 4].map((n) => makeId("chg", ulid(n)));
export const changeIdArb: fc.Arbitrary<ChangeId> = fc.constantFrom(...changeIds);

/** Lattice predicates plus the model-compared and pairwise ones, so every fallout path is reachable. */
export const graphPredicates: readonly Predicate[] = [
  "freshness", "cardinality", "authority", "presence", "ordering", "invariant",
];

export const graphPropositionArb: fc.Arbitrary<Proposition> = propositionArb({ predicates: graphPredicates });

export const heldPremiseArb: fc.Arbitrary<HeldPremise> = fc.record({
  holder: changeIdArb,
  proposition: graphPropositionArb,
});

export const tenetArb: fc.Arbitrary<GuardedTenet> = fc
  .tuple(fc.integer({ min: 1, max: 9 }), graphPropositionArb)
  .map(([n, proposition]) => ({
    id: makeId("tnt", ulid(n)),
    proposition,
    guards: [makeId("grd", ulid(n))],
  }));

export const evidenceArb: fc.Arbitrary<EvidenceClass> = fc.constantFrom(...EvidenceClass.literals);

export const derivedEffectArb = (proposition: fc.Arbitrary<Proposition> = graphPropositionArb): fc.Arbitrary<DerivedEffect> =>
  fc.record({
    proposition,
    method: fc.constantFrom("extractor" as const, "clef" as const, "code-model" as const),
    evidenceClass: evidenceArb,
    anchors: fc.constant([]),
    declared: fc.boolean(),
  });

const footprintPaths = [
  "src/authz/**", "src/authz/check.ts", "src/authz/cache.ts", "src/billing/*.ts", "src/billing/charge.ts", "docs/readme.md",
] as const;

export const footprintArb: fc.Arbitrary<readonly FootprintEntry[]> = fc
  .subarray([...footprintPaths], { maxLength: 2 })
  .map((paths) => paths.map((path) => ({ path: Glob.make(path), op: "edit" as const })));

export const intentArb: fc.Arbitrary<Intent> = fc.record({
  revision: fc.constant(1),
  goal: fc.constantFrom("speed up permission checks", "revoke collaborators", "bill per seat"),
  footprint: footprintArb,
  premises: fc.array(graphPropositionArb, { maxLength: 2 }),
  declaredEffects: fc.array(graphPropositionArb, { maxLength: 2 }),
});

export const liveChangeArb = (id: ChangeId): fc.Arbitrary<LiveChange> =>
  fc.record({
    id: fc.constant(id),
    intent: intentArb,
    derived: fc.array(derivedEffectArb(), { maxLength: 2 }),
  });

/** Live changes with distinct ids, none of them `self`. */
export const othersArb = (self: ChangeId): fc.Arbitrary<readonly LiveChange[]> =>
  fc
    .subarray(changeIds.filter((c) => c !== self), { minLength: 1 })
    .chain((ids) => fc.tuple(...ids.map((id) => liveChangeArb(id))));
