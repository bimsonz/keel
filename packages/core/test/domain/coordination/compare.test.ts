import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  assignable,
  type Authority,
  authorityLeq,
  type Cardinality,
  cardinalityLeq,
  type Claim,
  compare,
  type ComparisonOutcome,
  type Consistency,
  consistencyLeq,
  type Freshness,
  freshnessLeq,
  type Invalidated,
  isAncestorOrSelf,
  type Proposition,
  readClaim,
  readScope,
  scopeCovers,
  scopesIntersect,
  type Shape,
  subjectAncestors,
  SubjectKey,
  subjectsRelated,
  subjectsSiblings,
  writeProposition,
} from "../../../src/domain/coordination/index.ts";
import {
  authorityArb,
  cardinalityArb,
  comparablePairArb,
  consistencyArb,
  freshnessArb,
  generatedArb,
  key,
  latticeRelationArb,
  propositionArb,
  scopeArb,
  shapeArb,
  subjectArb,
  ttlValues,
  write,
} from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";

const latticePredicatesAll = [
  "freshness",
  "consistency",
  "cardinality",
  "bound",
  "authority",
  "presence",
  "purity",
  "idempotent",
  "shape",
  "ordering",
  "invariant",
] as const;
import {
  oracleDecision,
  specAuthorityLeq,
  specCardinalityLeq,
  specConsistencyLeq,
  specFreshnessLeq,
} from "../../oracles/coordination.ts";

const proposition = (
  subject: SubjectKey,
  claim: Claim,
  details: Parameters<typeof writeProposition>[2] = {},
): Proposition => writeProposition(subject, claim, details);

const wireScopesIntersect = (a: Proposition, b: Proposition): boolean =>
  scopesIntersect(Result.getOrThrow(readScope(a.scope)), Result.getOrThrow(readScope(b.scope)));

const outcomes: readonly ComparisonOutcome[] = [
  "compatible",
  "refines",
  "contradicts",
  "needs-probe",
  "unrelated",
];
const evaluation = key("authz.permission-evaluation");

const laws =
  <V>(leq: (a: V, b: V) => boolean | "unknown", eq: (a: V, b: V) => boolean) =>
  (a: V, b: V, c: V): boolean =>
    leq(a, a) === true &&
    (!(leq(a, b) === true && leq(b, a) === true) || eq(a, b)) &&
    (!(leq(a, b) === true && leq(b, c) === true) || leq(a, c) === true) &&
    (leq(a, b) === "unknown") === (leq(b, a) === "unknown");
const flipStrength = (p: Proposition): Proposition => ({
  ...p,
  strength: p.strength === "should" ? "must" : "should",
});
const ordering = (subject: string, before: boolean, other: string): Proposition => ({
  subject: key(subject),
  predicate: "ordering",
  relation: before ? "before" : "after",
  value: other,
});
const str: Shape = { _tag: "string" };
const num: Shape = { _tag: "number" };
const object = (fields: Record<string, Shape>, optional: readonly string[] = []): Shape => ({
  _tag: "object",
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, shape]) => [k, { shape, optional: optional.includes(k) }]),
  ),
});
const shapeOf = (relation: "at-most" | "at-least" | "is", value: Shape): Proposition =>
  proposition(evaluation, { predicate: "shape", relation, value });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameWriters = (a: Authority, b: Authority): boolean =>
  authorityLeq(a, b) && authorityLeq(b, a);

describe("lattices", () => {
  it("[lattice.orders-match-spec] every order agrees with its independent oracle", () => {
    fc.assert(
      fc.property(
        freshnessArb,
        freshnessArb,
        consistencyArb,
        consistencyArb,
        cardinalityArb,
        cardinalityArb,
        authorityArb,
        authorityArb,
        (f1, f2, c1, c2, k1, k2, a1, a2) => {
          expect(freshnessLeq(f1, f2)).toBe(specFreshnessLeq(f1, f2));
          expect(consistencyLeq(c1, c2)).toBe(specConsistencyLeq(c1, c2));
          expect(cardinalityLeq(k1, k2)).toBe(specCardinalityLeq(k1, k2));
          expect(authorityLeq(a1, a2)).toBe(specAuthorityLeq(a1, a2));
        },
      ),
    );
  });

  it("[lattice.partial-order-laws] each order is reflexive, antisymmetric and transitive where it decides", () => {
    fc.assert(
      fc.property(freshnessArb, freshnessArb, freshnessArb, laws<Freshness>(freshnessLeq, same)),
    );
    fc.assert(
      fc.property(
        consistencyArb,
        consistencyArb,
        consistencyArb,
        laws<Consistency>(consistencyLeq, same),
      ),
    );
    fc.assert(
      fc.property(
        cardinalityArb,
        cardinalityArb,
        cardinalityArb,
        laws<Cardinality>(cardinalityLeq, same),
      ),
    );
    fc.assert(
      fc.property(
        authorityArb,
        authorityArb,
        authorityArb,
        laws<Authority>(authorityLeq, sameWriters),
      ),
    );
    expect(freshnessLeq("per-session", { ttl: 60 })).toBe("unknown");
  });

  it("[lattice.session-ttl-needs-probe] per-session against any ttl(n) never yields a verdict", () => {
    fc.assert(
      fc.property(
        latticeRelationArb,
        latticeRelationArb,
        fc.constantFrom(...ttlValues),
        fc.boolean(),
        (r1, r2, ttl, sessionIsPremise) => {
          const session = proposition(evaluation, {
            predicate: "freshness",
            relation: r1,
            value: "per-session",
          });
          const timed = proposition(evaluation, {
            predicate: "freshness",
            relation: r2,
            value: { ttl },
          });
          const [p, e] = sessionIsPremise ? [session, timed] : [timed, session];
          expect(compare(p, e).outcome).toBe("needs-probe");
        },
      ),
    );
    const premise = proposition(evaluation, {
      predicate: "freshness",
      relation: "at-most",
      value: { ttl: 60 },
    });
    const effect = proposition(evaluation, {
      predicate: "freshness",
      relation: "is",
      value: "per-session",
    });
    expect(compare(premise, effect).outcome).toBe("needs-probe");
    expect(compare(effect, premise).outcome).toBe("needs-probe");
  });
});

describe("compare", () => {
  it("[compare.matches-lattice-oracle] decides exactly as a pointwise oracle does, and reaches every outcome", () => {
    const seen = new Set<ComparisonOutcome>();
    fc.assert(
      fc.property(comparablePairArb(), ({ premise, effect }) => {
        const { outcome } = compare(write(premise), write(effect));
        seen.add(outcome);
        if (
          !subjectsRelated(premise.subject, effect.subject) ||
          !scopesIntersect(premise.scope, effect.scope)
        )
          return true;
        const oracle = oracleDecision(premise.claim, effect.claim);
        if (oracle === undefined) return true;
        if (oracle === "disjoint") return outcome === "contradicts";
        if (oracle === "overlap") return outcome === "needs-probe";
        return outcome === "compatible" || outcome === "refines";
      }),
      { numRuns: 2000 },
    );
    expect([...seen].toSorted()).toEqual([...outcomes].toSorted());
  });

  it("[compare.invariant-never-contradicts] an invariant on either side needs a probe, never a verdict", () => {
    fc.assert(
      fc.property(
        propositionArb({ predicates: ["invariant"] }),
        propositionArb({
          predicates: ["freshness", "cardinality", "invariant", "authority", "presence"],
        }),
        fc.boolean(),
        fc.boolean(),
        (invariant, other, invariantIsPremise, shareSubject) => {
          const peer = shareSubject
            ? { ...other, subject: invariant.subject, scope: invariant.scope }
            : other;
          const [p, e] = invariantIsPremise ? [invariant, peer] : [peer, invariant];
          const { outcome } = compare(p, e);
          const comparable = subjectsRelated(p.subject, e.subject) && wireScopesIntersect(p, e);
          return outcome !== "contradicts" && (!comparable || outcome === "needs-probe");
        },
      ),
    );
    const invariant = proposition(evaluation, {
      predicate: "invariant",
      relation: "is",
      value: "revoked users cannot act",
    });
    const cache = proposition(evaluation, {
      predicate: "freshness",
      relation: "is",
      value: "per-session",
    });
    expect(compare(invariant, cache).outcome).toBe("needs-probe");
  });

  it("[compare.unrelated-outside-subject-and-scope] unrelated subjects, disjoint scopes or different predicates never compare", () => {
    fc.assert(
      fc.property(propositionArb(), propositionArb(), (p, e) => {
        const { outcome } = compare(p, e);
        const outside = !subjectsRelated(p.subject, e.subject) || !wireScopesIntersect(p, e);
        return !(outside || p.predicate !== e.predicate) || outcome === "unrelated";
      }),
    );
    const premise = proposition(
      evaluation,
      { predicate: "freshness", relation: "at-most", value: "per-request" },
      { scope: { env: ["prod"] } },
    );
    const effect = proposition(
      evaluation,
      { predicate: "freshness", relation: "is", value: "per-session" },
      { scope: { env: ["staging"] } },
    );
    expect(compare(premise, effect).outcome).toBe("unrelated");
  });

  it("[compare.parent-subjects-checked] a contradiction is found across parent and child, never across siblings", () => {
    fc.assert(
      fc.property(subjectArb, subjectArb, fc.boolean(), (a, b, flip) => {
        const premise = proposition(a, {
          predicate: "freshness",
          relation: "at-most",
          value: "per-request",
        });
        const effect = proposition(b, {
          predicate: "freshness",
          relation: "is",
          value: "per-session",
        });
        const [p, e] = flip ? [effect, premise] : [premise, effect];
        const contradicts = compare(premise, effect).outcome === "contradicts";
        return (
          contradicts === subjectsRelated(a, b) &&
          (!subjectsSiblings(a, b) || compare(p, e).outcome === "unrelated")
        );
      }),
    );
    const parentPremise = proposition(key("authz"), {
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    });
    const childEffect = proposition(evaluation, {
      predicate: "freshness",
      relation: "is",
      value: "per-session",
    });
    expect(compare(parentPremise, childEffect).outcome).toBe("contradicts");
    const childPremise = proposition(evaluation, {
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    });
    const parentEffect = proposition(key("authz"), {
      predicate: "freshness",
      relation: "is",
      value: "per-session",
    });
    expect(compare(childPremise, parentEffect).outcome).toBe("contradicts");
  });

  it("[compare.refines-iff-partial-coverage] consistent effects are compatible when they cover the premise, else refines", () => {
    fc.assert(
      fc.property(comparablePairArb(), ({ premise, effect }) => {
        const { outcome } = compare(write(premise), write(effect));
        if (outcome !== "compatible" && outcome !== "refines") return true;
        const covers =
          isAncestorOrSelf(effect.subject, premise.subject) &&
          scopeCovers(effect.scope, premise.scope);
        return outcome === (covers ? "compatible" : "refines");
      }),
      { numRuns: 1000 },
    );
    const premise = proposition(key("authz"), {
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    });
    const narrow = proposition(evaluation, {
      predicate: "freshness",
      relation: "is",
      value: "per-call",
    });
    expect(compare(premise, narrow).outcome).toBe("refines");
    expect(compare(premise, { ...narrow, subject: key("authz") }).outcome).toBe("compatible");
  });

  it("[compare.strength-never-read] flipping must and should never changes a comparison", () => {
    fc.assert(
      fc.property(comparablePairArb(), ({ premise: pg, effect: eg }) => {
        const premise = write(pg);
        const effect = write(eg);
        expect(compare(flipStrength(premise), flipStrength(effect))).toEqual(
          compare(premise, effect),
        );
        expect(compare(flipStrength(premise), effect)).toEqual(compare(premise, effect));
      }),
    );
  });

  it("[compare.ordering-pairs] the same pair agrees, the reversed pair contradicts, another pair is unrelated", () => {
    expect(
      compare(ordering("authz.revoke", true, "respond"), ordering("authz.revoke", true, "respond"))
        .outcome,
    ).toBe("compatible");
    expect(
      compare(ordering("authz.revoke", true, "respond"), ordering("authz.revoke", false, "respond"))
        .outcome,
    ).toBe("contradicts");
    expect(
      compare(ordering("authz.revoke", true, "respond"), ordering("authz.revoke", true, "audit"))
        .outcome,
    ).toBe("unrelated");
  });
});

describe("shape", () => {
  it("[compare.shape-assignability] assignability is reflexive and width-subtyped, and a dropped field contradicts", () => {
    fc.assert(
      fc.property(shapeArb, (s) => {
        expect(assignable(s, s)).toBe(true);
        expect(assignable(s, { _tag: "unknown" })).not.toBe(false);
        expect(assignable({ _tag: "never" }, s)).not.toBe(false);
      }),
    );
    const reader = shapeOf("at-most", object({ id: str, role: str }));
    expect(compare(reader, shapeOf("is", object({ id: str, role: str, ttl: num }))).outcome).toBe(
      "compatible",
    );
    expect(compare(reader, shapeOf("is", object({ id: str }))).outcome).toBe("contradicts");
    expect(compare(reader, shapeOf("is", object({ id: str, role: str }, ["role"]))).outcome).toBe(
      "contradicts",
    );
    expect(compare(reader, shapeOf("is", object({ id: str, role: num }))).outcome).toBe(
      "contradicts",
    );
    expect(compare(reader, shapeOf("is", { _tag: "opaque", name: "Grant" })).outcome).toBe(
      "needs-probe",
    );
  });
});

describe("subjects and scopes", () => {
  it("[subject.key-round-trip] valid keys parse to themselves, ancestors are proper prefixes, bad keys are refused", () => {
    fc.assert(
      fc.property(subjectArb, (k) => {
        expect(Schema.decodeUnknownSync(SubjectKey)(k)).toBe(k);
        for (const a of subjectAncestors(k)) {
          expect(isAncestorOrSelf(a, k)).toBe(true);
          expect(a).not.toBe(k);
        }
        expect(subjectAncestors(k).length).toBe(k.split(".").length - 1);
      }),
    );
    for (const bad of ["", "authz.", ".authz", "Authz", "authz..cache", "auth_z", "authz.-x"]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(SubjectKey)(bad))).toBe(true);
    }
    expect(isAncestorOrSelf(key("authz"), key("authz-admin"))).toBe(false);
  });

  it("[scope.intersection-laws] intersection is symmetric, everywhere meets all, and covering implies meeting", () => {
    fc.assert(
      fc.property(scopeArb, scopeArb, (a, b) => {
        expect(scopesIntersect(a, b)).toBe(scopesIntersect(b, a));
        expect(scopesIntersect({}, a)).toBe(true);
        expect(scopeCovers({}, a)).toBe(true);
        expect(!scopeCovers(a, b) || scopesIntersect(a, b)).toBe(true);
        expect(scopeCovers(a, a)).toBe(true);
      }),
    );
    expect(scopesIntersect({ env: ["prod"] }, { env: ["staging"] })).toBe(false);
    expect(scopeCovers({ env: ["prod"] }, {})).toBe(false);
  });
});

describe("claims on the wire", () => {
  it("[claim.round-trip] every typed claim survives being written and read back", () => {
    fc.assert(
      fc.property(generatedArb({ predicates: [...latticePredicatesAll] }), (g) => {
        const read = readClaim(write(g));
        expect(Result.isSuccess(read)).toBe(true);
        const back = Result.getOrThrow(read);
        expect(back.claim).toEqual(g.claim);
        expect(back.scope).toEqual(
          Object.fromEntries(Object.entries(g.scope).map(([d, a]) => [d, [...a].toSorted()])),
        );
        expect(back.strength).toBe(g.strength);
      }),
    );
  });

  it("[claim.unreadable-needs-probe] a proposition off the grammar never contradicts or clears", () => {
    const bad: readonly Proposition[] = [
      { subject: evaluation, predicate: "freshness", relation: "at-most", value: "hourly" },
      { subject: evaluation, predicate: "freshness", relation: "before", value: "per-call" },
      { subject: evaluation, predicate: "bound", relation: "at-most", value: "fast" },
      { subject: evaluation, predicate: "authority", relation: "is", value: "a,a" },
      { subject: evaluation, predicate: "shape", relation: "is", value: "{not json" },
      { subject: evaluation, predicate: "shape", relation: "is", value: '{"_tag":"tuple"}' },
      { subject: evaluation, predicate: "ordering", relation: "is", value: "respond" },
      { subject: evaluation, predicate: "presence", relation: "at-most", value: true },
      { subject: evaluation, predicate: "invariant", relation: "is", value: " " },
      {
        subject: evaluation,
        predicate: "freshness",
        relation: "is",
        value: "per-call",
        scope: "env=prod",
      },
    ];
    const readable = proposition(evaluation, {
      predicate: "freshness",
      relation: "is",
      value: "per-session",
    });
    for (const p of bad) {
      expect(Result.isFailure(readClaim(p))).toBe(true);
      expect(compare(p, readable)).toEqual({ outcome: "needs-probe", reason: "unreadable" });
      expect(compare(readable, p)).toEqual({ outcome: "needs-probe", reason: "unreadable" });
      expect(compare({ ...p, subject: key("billing") }, readable).outcome).toBe("unrelated");
    }
  });
});

// ------------------------------------------------- cached, invalidated on E

const eventKeyArb = fc.constantFrom("authz.revoke", "authz.grant", "role.delete", "session.end");
const invalidatedArb = (
  cached: fc.Arbitrary<Freshness> = freshnessArb,
): fc.Arbitrary<Invalidated> =>
  fc.record({
    cached,
    invalidatedOn: fc
      .uniqueArray(eventKeyArb, { minLength: 1, maxLength: 3 })
      .map((keys) => keys.toSorted()),
  });
const evictingRelationArb = fc.constantFrom<"is" | "at-most">("is", "at-most");
const fresh = (relation: Claim["relation"], value: Freshness | Invalidated): Proposition =>
  proposition(evaluation, { predicate: "freshness", relation, value });
const refusedOnWire = (relation: Proposition["relation"], value: string): boolean =>
  Result.isFailure(readClaim({ subject: evaluation, predicate: "freshness", relation, value }));
const rank = { contradicts: 0, "needs-probe": 1, refines: 2, compatible: 2, unrelated: -1 };

describe("freshness: cached, invalidated on E", () => {
  it("[freshness.invalidation-sound] decides only what holds whichever other events change the subject, as brute force over event worlds does", () => {
    const seen = new Set<ComparisonOutcome>();
    fc.assert(
      fc.property(
        latticeRelationArb,
        freshnessArb,
        evictingRelationArb,
        invalidatedArb(),
        (pr, pv, er, ev) => {
          const premise: Claim = { predicate: "freshness", relation: pr, value: pv };
          const effect: Claim = { predicate: "freshness", relation: er, value: ev };
          const { outcome } = compare(fresh(pr, pv), fresh(er, ev));
          seen.add(outcome);
          const oracle = oracleDecision(premise, effect);
          if (oracle === "disjoint") return outcome === "contradicts";
          if (oracle === "overlap") return outcome === "needs-probe";
          return outcome === "compatible";
        },
      ),
      { numRuns: 1000 },
    );
    expect([...seen].toSorted()).toEqual(["compatible", "contradicts", "needs-probe"]);
  });

  it("[freshness.invalidation-never-staler] against at-most v the form never decides worse than its base, and never contradicts a premise at or above per-request", () => {
    fc.assert(
      fc.property(freshnessArb, evictingRelationArb, invalidatedArb(), (pv, er, ev) => {
        const premise = fresh("at-most", pv);
        const form = rank[compare(premise, fresh(er, ev)).outcome];
        const base = rank[compare(premise, fresh(er, ev.cached)).outcome];
        const lenient = specFreshnessLeq("per-request", pv) === true;
        return form >= base && (!lenient || form > rank.contradicts);
      }),
    );
    // A per-session cache evicted on revoke never contradicts "at most per-request".
    const bPrime = fresh("is", { cached: "per-session", invalidatedOn: ["authz.revoke"] });
    expect(compare(fresh("at-most", "per-request"), bPrime).outcome).not.toBe("contradicts");
  });

  it("[freshness.invalidation-fresh-base] a base at or below per-request compares exactly as the base does", () => {
    const freshBase = fc.constantFrom<Freshness>("per-call", "per-request");
    fc.assert(
      fc.property(
        latticeRelationArb,
        freshnessArb,
        evictingRelationArb,
        invalidatedArb(freshBase),
        (pr, pv, er, ev) =>
          compare(fresh(pr, pv), fresh(er, ev)).outcome ===
          compare(fresh(pr, pv), fresh(er, ev.cached)).outcome,
      ),
    );
    const perCall = fresh("is", { cached: "per-call", invalidatedOn: ["authz.revoke"] });
    expect(compare(fresh("at-most", "per-call"), perCall).outcome).toBe("compatible");
  });

  it("[freshness.s1-bprime] S-1: B\u2032, per-session evicted on revoke, needs a probe against at most per-request; the careless patch contradicts; B is compatible", () => {
    const premise = fresh("at-most", "per-request");
    const b = fresh("is", "per-request");
    const bPrime = fresh("is", { cached: "per-session", invalidatedOn: ["authz.revoke"] });
    const careless = fresh("is", "per-session");
    expect(bPrime.value).toBe("per-session invalidated-on authz.revoke");
    expect(compare(premise, bPrime).outcome).toBe("needs-probe");
    expect(compare(premise, careless).outcome).toBe("contradicts");
    expect(compare(premise, b).outcome).toBe("compatible");
  });

  it("[freshness.invalidation-wire] the form is written with its keys sorted and deduped, reads back equal, and every other spelling is refused", () => {
    fc.assert(
      fc.property(
        evictingRelationArb,
        freshnessArb,
        fc.array(eventKeyArb, { minLength: 1, maxLength: 5 }),
        (relation, cached, keys) => {
          const written = fresh(relation, { cached, invalidatedOn: keys });
          const canonical = [...new Set(keys)].toSorted();
          const read = readClaim(written);
          return (
            typeof written.value === "string" &&
            written.value.endsWith(` invalidated-on ${canonical.join(",")}`) &&
            Result.isSuccess(read) &&
            JSON.stringify(read.success.claim.value) ===
              JSON.stringify({ cached, invalidatedOn: canonical })
          );
        },
      ),
    );
    expect(refusedOnWire("is", "per-session invalidated-on authz.revoke,authz.grant")).toBe(true);
    expect(refusedOnWire("is", "per-session invalidated-on authz.grant,authz.grant")).toBe(true);
    expect(refusedOnWire("is", "per-session invalidated-on ")).toBe(true);
    expect(refusedOnWire("is", "per-session invalidated-on Authz.Revoke")).toBe(true);
    expect(refusedOnWire("at-least", "per-session invalidated-on authz.revoke")).toBe(true);
    expect(refusedOnWire("not", "per-session invalidated-on authz.revoke")).toBe(true);
    expect(refusedOnWire("is", "hourly invalidated-on authz.revoke")).toBe(true);
    expect(refusedOnWire("at-most", "ttl:60 invalidated-on authz.grant,authz.revoke")).toBe(false);
  });

  it("[freshness.premise-invalidation-refused] a premise in the invalidation form is refused with a next action, and needs a probe against anything", () => {
    fc.assert(
      fc.property(
        evictingRelationArb,
        invalidatedArb(),
        latticeRelationArb,
        freshnessArb,
        (pr, pv, er, ev) => {
          const premise = fresh(pr, pv);
          const read = readClaim(premise, "premise");
          return (
            Result.isFailure(read) &&
            (read.failure.nextActions ?? []).some((a) => a.operationId === "revise") &&
            Result.isSuccess(readClaim(premise, "effect")) &&
            compare(premise, fresh(er, ev)).outcome === "needs-probe"
          );
        },
      ),
    );
    const refused = readClaim(
      fresh("is", { cached: "per-session", invalidatedOn: ["authz.revoke"] }),
      "premise",
    );
    expect(Result.isFailure(refused) && refused.failure.reason).toMatch(/effect form/);
  });
});
