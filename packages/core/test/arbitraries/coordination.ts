import {
  type Authority,
  type Bound,
  type Cardinality,
  type Claim,
  type ClaimRelation,
  type Consistency,
  type Freshness,
  type Predicate,
  type Proposition,
  type Scope,
  type Shape,
  type Strength,
  SubjectKey,
  writeProposition,
} from "../../src/domain/coordination/index.ts";
import { type Anchor, CommitSha } from "../../src/domain/kernel/index.ts";
import { fc } from "../support/fast-check.ts";

export const key = (s: string): SubjectKey => SubjectKey.make(s);

// Small alphabets, so generated subjects, scopes and values collide often.
const tops = ["authz", "billing"] as const;
const mids = ["permission-evaluation", "cache", "audit-log"] as const;
const leaves = ["read", "write"] as const;

export const subjectArb: fc.Arbitrary<SubjectKey> = fc
  .tuple(
    fc.constantFrom(...tops),
    fc.constantFrom(...mids),
    fc.constantFrom(...leaves),
    fc.integer({ min: 1, max: 3 }),
  )
  .map(([a, b, c, depth]) => key([a, b, c].slice(0, depth).join(".")));

export const scopeArb: fc.Arbitrary<Scope> = fc
  .record(
    {
      env: fc.subarray(["prod", "staging"], { minLength: 1 }),
      tenant: fc.subarray(["t1", "t2", "t3"], { minLength: 1 }),
    },
    { requiredKeys: [] },
  )
  .map((s): Scope => s);

export const latticeRelationArb: fc.Arbitrary<ClaimRelation> = fc.constantFrom(
  "at-most",
  "at-least",
  "is",
  "not",
);
const rangeRelationArb = fc.constantFrom("at-most" as const, "at-least" as const, "is" as const);

export const ttlValues = [0, 30, 60, 300] as const;
export const freshnessArb: fc.Arbitrary<Freshness> = fc.oneof(
  fc.constantFrom<Freshness>("per-call", "per-request", "per-session", "static"),
  fc.constantFrom(...ttlValues).map((ttl): Freshness => ({ ttl })),
);

export const consistencyArb: fc.Arbitrary<Consistency> = fc.oneof(
  fc.constantFrom<Consistency>("eventual", "read-your-writes", "linearizable"),
  fc.constantFrom(0, 1, 5).map((bounded): Consistency => ({ bounded })),
);

export const cardinalityArb: fc.Arbitrary<Cardinality> = fc.constantFrom(
  "exactly-once",
  "at-most-once",
  "at-least-once",
  "any",
);

export const boundArb: fc.Arbitrary<Bound> = fc.record({
  n: fc.constantFrom(-1, 0, 1, 5, 10),
  unit: fc.constantFrom("ms", "ms", "ms", "req"),
});

export const authorityArb: fc.Arbitrary<Authority> = fc
  .subarray(["a", "b", "c"])
  .map((w): Authority => ({ writers: w }));

export const shapeArb: fc.Arbitrary<Shape> = fc.letrec<{ shape: Shape }>((tie) => ({
  shape: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom<Shape>(
      { _tag: "string" },
      { _tag: "number" },
      { _tag: "null" },
      { _tag: "unknown" },
    ),
    fc.constantFrom("a", "b", 1).map((value): Shape => ({ _tag: "literal", value })),
    fc.constantFrom("Session", "Grant").map((name): Shape => ({ _tag: "opaque", name })),
    tie("shape").map((of): Shape => ({ _tag: "array", of })),
    fc
      .dictionary(
        fc.constantFrom("id", "role", "ttl"),
        fc.record({ shape: tie("shape"), optional: fc.boolean() }),
        {
          maxKeys: 3,
        },
      )
      .map((fields): Shape => ({ _tag: "object", fields })),
    fc
      .array(tie("shape"), { minLength: 2, maxLength: 3 })
      .map((of): Shape => ({ _tag: "union", of })),
  ),
})).shape;

const events = ["check", "cache", "respond"] as const;

/** A claim for a predicate; ordering claims start at the subject, as the wire grammar requires. */
export const claimArb = (predicate: Predicate, subject: SubjectKey): fc.Arbitrary<Claim> => {
  switch (predicate) {
    case "freshness":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: latticeRelationArb,
        value: freshnessArb,
      });
    case "consistency":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: latticeRelationArb,
        value: consistencyArb,
      });
    case "cardinality":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: latticeRelationArb,
        value: cardinalityArb,
      });
    case "bound":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: latticeRelationArb,
        value: boundArb,
      });
    case "authority":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: rangeRelationArb,
        value: authorityArb,
      });
    case "shape":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: rangeRelationArb,
        value: shapeArb,
      });
    case "presence":
    case "purity":
    case "idempotent":
      return fc.record({
        predicate: fc.constant(predicate),
        relation: fc.constantFrom("is" as const, "not" as const),
        value: fc.boolean(),
      });
    case "ordering":
      return fc.tuple(fc.constantFrom(...events), fc.boolean()).map(([event, after]): Claim => ({
        predicate: "ordering",
        relation: "is",
        value: after ? { before: event, after: subject } : { before: subject, after: event },
      }));
    default:
      return fc.record({
        predicate: fc.constant("invariant" as const),
        relation: fc.constant("is" as const),
        value: fc.constantFrom("revoked users cannot act", "every grant is audited"),
      });
  }
};

/** Predicates whose comparison the lattice can decide. */
export const latticePredicates: readonly Predicate[] = [
  "freshness",
  "consistency",
  "cardinality",
  "bound",
  "authority",
  "presence",
  "purity",
  "idempotent",
];

export const strengthArb: fc.Arbitrary<Strength> = fc.constantFrom("must", "should");

const anchorPaths = ["src/authz/check.ts", "src/authz/cache.ts", "src/billing/charge.ts"] as const;
export const anchorArb: fc.Arbitrary<Anchor> = fc
  .constantFrom(...anchorPaths)
  .map((path) => ({ path, commit: CommitSha.make("a".repeat(40)) }));

export type Generated = {
  readonly subject: SubjectKey;
  readonly claim: Claim;
  readonly scope: Scope;
  readonly strength: Strength;
};

export const generatedArb = (
  options: {
    readonly predicates?: readonly Predicate[];
    readonly subject?: fc.Arbitrary<SubjectKey>;
  } = {},
): fc.Arbitrary<Generated> =>
  fc
    .tuple(
      fc.constantFrom(...(options.predicates ?? latticePredicates)),
      options.subject ?? subjectArb,
    )
    .chain(([predicate, subject]) =>
      fc.record({
        subject: fc.constant(subject),
        claim: claimArb(predicate, subject),
        scope: scopeArb,
        strength: strengthArb,
      }),
    );

export const write = (g: Generated, anchors: readonly Anchor[] = []): Proposition =>
  writeProposition(g.subject, g.claim, { scope: g.scope, strength: g.strength, anchors });

/** A wire proposition, with up to one anchor. */
export const propositionArb = (
  options: {
    readonly predicates?: readonly Predicate[];
    readonly subject?: fc.Arbitrary<SubjectKey>;
  } = {},
): fc.Arbitrary<Proposition> =>
  fc
    .tuple(generatedArb(options), fc.subarray([...anchorPaths], { maxLength: 1 }))
    .map(([g, paths]) =>
      write(
        g,
        paths.map((path) => ({ path, commit: CommitSha.make("a".repeat(40)) })),
      ),
    );

/** A premise and an effect on one predicate, usually on related subjects with overlapping scopes. */
export const comparablePairArb = (predicates: readonly Predicate[] = latticePredicates) =>
  fc
    .constantFrom(...predicates)
    .chain((predicate) =>
      fc.record({
        premise: generatedArb({ predicates: [predicate] }),
        effect: generatedArb({ predicates: [predicate] }),
        shareSubject: fc.boolean(),
        shareScope: fc.boolean(),
      }),
    )
    .map(({ premise, effect, shareSubject, shareScope }) => {
      const e: Generated = {
        ...effect,
        subject: shareSubject ? premise.subject : effect.subject,
        scope: shareScope ? premise.scope : effect.scope,
      };
      return { premise, effect: e };
    });
