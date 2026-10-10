import { describe, expect, it } from "vitest";
import {
  compare,
  type DerivedEffect,
  exposure,
  fallout,
  type Fallout,
  type HeldPremise,
  type Intent,
  type Proposition,
  readScope,
  scopesIntersect,
  subjectsRelated,
  subjectsSiblings,
} from "../../../src/domain/coordination/index.ts";
import { key } from "../../arbitraries/coordination.ts";
import {
  changeIdArb,
  changeIds,
  derivedEffectArb,
  heldPremiseArb,
  intentArb,
  othersArb,
  tenetArb,
} from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

const reliedOn = (f: Fallout): Proposition =>
  f.target._tag === "premise" ? f.target.premise.proposition : f.target.tenet.proposition;

const isMust = (p: Proposition): boolean => (p.strength ?? "must") === "must";

const sharesAnchor = (a: Proposition, b: Proposition): boolean =>
  (a.anchors ?? []).some((x) => (b.anchors ?? []).some((y) => x.path === y.path));

const scopesMeet = (a: Proposition, b: Proposition): boolean => {
  const sa = readScope(a.scope);
  const sb = readScope(b.scope);
  return sa._tag === "Failure" || sb._tag === "Failure" || scopesIntersect(sa.success, sb.success);
};

const near = (a: Proposition, b: Proposition): boolean =>
  subjectsRelated(a.subject, b.subject) || subjectsSiblings(a.subject, b.subject) || sharesAnchor(a, b);

const graphArb = fc.record({
  change: changeIdArb,
  effect: derivedEffectArb(),
  premises: fc.array(heldPremiseArb, { maxLength: 6 }),
  tenets: fc.array(tenetArb, { maxLength: 3 }),
});

const evaluation = key("authz.permission-evaluation");
const premiseA: HeldPremise = {
  holder: changeIds[0] ?? changeIds[1]!,
  proposition: { subject: evaluation, predicate: "freshness", relation: "at-most", value: "per-request" },
};
const cacheEffect = (value: string, declared: boolean): DerivedEffect => ({
  proposition: { subject: evaluation, predicate: "freshness", relation: "is", value },
  method: "clef",
  evidenceClass: "opinion",
  p: 0.93,
  anchors: [],
  declared,
});

describe("fallout", () => {
  it("[fallout.conflict-only-on-contradiction] a conflict needs a same-key contradiction against a must premise or a tenet", () => {
    let conflicts = 0;
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises, tenets }) =>
        fallout(change, effect, premises, tenets)
          .filter((f) => f._tag === "conflict")
          .every((f) => {
            conflicts++;
            const relied = reliedOn(f);
            return (
              compare(relied, effect.proposition).outcome === "contradicts" &&
              relied.predicate === effect.proposition.predicate &&
              subjectsRelated(relied.subject, effect.proposition.subject) &&
              (f.target._tag === "tenet" || isMust(relied))
            );
          }),
      ),
    );
    expect(conflicts).toBeGreaterThan(0);
  });

  it("[fallout.contradiction-opens-conflict] every contradicted must premise of another change, and every contradicted tenet, gets a conflict", () => {
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises, tenets }) => {
        const out = fallout(change, effect, premises, tenets);
        const conflicted = new Set(out.filter((f) => f._tag === "conflict").map((f) => f.target));
        const premisesOk = premises
          .filter((p) => p.holder !== change && isMust(p.proposition))
          .filter((p) => compare(p.proposition, effect.proposition).outcome === "contradicts")
          .every((p) => [...conflicted].some((t) => t._tag === "premise" && t.premise === p));
        const tenetsOk = tenets
          .filter((t) => compare(t.proposition, effect.proposition).outcome === "contradicts")
          .every((t) => [...conflicted].some((c) => c._tag === "tenet" && c.tenet === t));
        return premisesOk && tenetsOk;
      }),
    );
    const out = fallout(changeIds[1]!, cacheEffect("per-session", false), [premiseA], []);
    expect(out.map((f) => f._tag)).toEqual(["conflict"]);
  });

  it("[fallout.suspect-when-clause-touched] suspect exactly when the effect speaks to the clause without breaking a must", () => {
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises, tenets }) => {
        const out = fallout(change, effect, premises, tenets);
        return premises
          .filter((p) => p.holder !== change)
          .every((p) => {
            const outcome = compare(p.proposition, effect.proposition).outcome;
            const expected =
              outcome === "compatible" || outcome === "refines" || outcome === "needs-probe" ||
              (outcome === "contradicts" && !isMust(p.proposition));
            const got = out.some((f) => f._tag === "suspect" && f.target._tag === "premise" && f.target.premise === p);
            return got === expected;
          });
      }),
    );
    const decoy = fallout(changeIds[1]!, cacheEffect("per-request", false), [premiseA], []);
    expect(decoy.map((f) => f._tag)).toEqual(["suspect"]);
  });

  it("[fallout.should-premise-only-suspect] contradicting a should premise is suspect, never a conflict", () => {
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises }) => {
        const shoulds = premises.map((p) => ({ ...p, proposition: { ...p.proposition, strength: "should" as const } }));
        return fallout(change, effect, shoulds, []).every((f) => f._tag !== "conflict");
      }),
    );
    const should: HeldPremise = { ...premiseA, proposition: { ...premiseA.proposition, strength: "should" } };
    expect(fallout(changeIds[1]!, cacheEffect("per-session", false), [should], []).map((f) => f._tag)).toEqual(["suspect"]);
  });

  it("[fallout.own-premises-excluded] a change's own premises never receive its fallout", () => {
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises, tenets }) =>
        fallout(change, effect, premises, tenets).every((f) => f.target._tag !== "premise" || f.target.premise.holder !== change),
      ),
    );
    expect(fallout(premiseA.holder, cacheEffect("per-session", false), [premiseA], [])).toEqual([]);
  });

  it("[fallout.silent-retraction-iff-undeclared] a conflict is a silent retraction exactly when the effect was undeclared", () => {
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises, tenets }) =>
        fallout(change, effect, premises, tenets).every((f) => f._tag !== "conflict" || f.silentRetraction === !effect.declared),
      ),
    );
    const [silent] = fallout(changeIds[1]!, cacheEffect("per-session", false), [premiseA], []);
    expect(silent?._tag === "conflict" && silent.silentRetraction).toBe(true);
  });

  it("[fallout.proximity-only-notifies] notify comes only from proximity, and every nearby unrelated clause is notified", () => {
    fc.assert(
      fc.property(graphArb, ({ change, effect, premises, tenets }) => {
        const out = fallout(change, effect, premises, tenets);
        return premises
          .filter((p) => p.holder !== change)
          .every((p) => {
            const unrelated = compare(p.proposition, effect.proposition).outcome === "unrelated";
            const notified = out.some((f) => f._tag === "notify" && f.target._tag === "premise" && f.target.premise === p);
            const reached = out.some((f) => f.target._tag === "premise" && f.target.premise === p);
            if (!unrelated) return !notified;
            return notified === near(p.proposition, effect.proposition) && (notified || !reached);
          });
      }),
    );
    const sibling: HeldPremise = { ...premiseA, proposition: { ...premiseA.proposition, subject: key("authz.audit-log") } };
    const [notice] = fallout(changeIds[1]!, cacheEffect("per-session", false), [sibling], []);
    expect(notice?._tag === "notify" ? notice.reason : notice?._tag).toBe("sibling-subject");
  });
});

describe("exposure", () => {
  const exposureArb = changeIdArb.chain((self) =>
    fc.record({ self: fc.constant(self), intent: intentArb, others: othersArb(self) }),
  );

  it("[exposure.covers-fallout] every change fallout could reach from the intent's effects is a neighbour", () => {
    fc.assert(
      fc.property(exposureArb, ({ self, intent, others }) => {
        const listed = new Set(exposure(self, intent, others).neighbours.map((n) => n.changeId));
        const premises: HeldPremise[] = others.flatMap((o) => o.intent.premises.map((proposition) => ({ holder: o.id, proposition })));
        return (intent.declaredEffects ?? []).every((proposition) =>
          fallout(self, { proposition, method: "extractor", evidenceClass: "proof", anchors: [], declared: true }, premises, [])
            .every((f) => f.target._tag !== "premise" || listed.has(f.target.premise.holder)),
        );
      }),
    );
    const b: Intent = { revision: 1, goal: "speed up permission checks", footprint: [], premises: [], declaredEffects: [cacheEffect("per-session", true).proposition] };
    const a = { id: premiseA.holder, intent: { revision: 1, goal: "revoke collaborators", footprint: [], premises: [premiseA.proposition] }, derived: [] };
    expect(exposure(changeIds[1]!, b, [a]).neighbours.map((n) => n.changeId)).toEqual([premiseA.holder]);
  });

  it("[exposure.precision-floor] a change with nothing near and no overlapping footprint is never a neighbour", () => {
    let distant = 0;
    fc.assert(
      fc.property(exposureArb, ({ self, intent, others }) => {
        const mine = [...intent.premises, ...(intent.declaredEffects ?? [])];
        const listed = new Set(exposure(self, intent, others).neighbours.map((n) => n.changeId));
        return others.every((o) => {
          const theirs = [...o.intent.premises, ...(o.intent.declaredEffects ?? []), ...o.derived.map((d) => d.proposition)];
          const isNear = mine.some((m) => theirs.some((t) => near(m, t)));
          const footprint = intent.footprint.length > 0 && o.intent.footprint.length > 0;
          if (isNear || footprint) return true;
          distant++;
          return !listed.has(o.id);
        });
      }),
    );
    expect(distant).toBeGreaterThan(0);
  });

  it("[exposure.reports-contradictions] contradictions are exactly my premises against theirs or their effects, and theirs against my declared effects", () => {
    fc.assert(
      fc.property(exposureArb, ({ self, intent, others }) => {
        const reported = exposure(self, intent, others).contradictions;
        const expected = others.flatMap((o) => {
          const theirs = [...o.intent.premises, ...(o.intent.declaredEffects ?? []), ...o.derived.map((d) => d.proposition)];
          return [
            ...intent.premises.flatMap((p) => theirs.map((t) => ({ premise: p, with: t, holder: self }))),
            ...o.intent.premises.flatMap((p) => (intent.declaredEffects ?? []).map((e) => ({ premise: p, with: e, holder: o.id }))),
          ].filter((c) => compare(c.premise, c.with).outcome === "contradicts");
        });
        expect(reported).toEqual(expected);
      }),
    );
  });

  it("[exposure.unreadable-noticed] an intent's propositions off the grammar come back as notices", () => {
    const intent: Intent = {
      revision: 1,
      goal: "speed up permission checks",
      footprint: [],
      premises: [{ subject: evaluation, predicate: "freshness", relation: "at-most", value: "hourly" }],
      declaredEffects: [{ subject: evaluation, predicate: "freshness", relation: "is", value: "per-session" }],
    };
    const { unreadable } = exposure(changeIds[0]!, intent, []);
    expect(unreadable.map((u) => [u.predicate, u.reason])).toEqual([["freshness", '"hourly" is not a freshness']]);
    fc.assert(
      fc.property(intentArb, (i) => exposure(changeIds[0]!, i, []).unreadable.length === 0),
    );
  });
});

describe("the S-1 premise against B's cache", () => {
  it("[fallout.scope-respected] an effect in a disjoint scope only notifies", () => {
    const scoped: DerivedEffect = { ...cacheEffect("per-session", false), proposition: { ...cacheEffect("per-session", false).proposition, scope: "env:staging" } };
    const scopedPremise: HeldPremise = { ...premiseA, proposition: { ...premiseA.proposition, scope: "env:prod" } };
    const [only] = fallout(changeIds[1]!, scoped, [scopedPremise], []);
    expect(only?._tag === "notify" ? only.reason : only?._tag).toBe("scope-disjoint");
    expect(scopesMeet(scoped.proposition, scopedPremise.proposition)).toBe(false);
  });
});
