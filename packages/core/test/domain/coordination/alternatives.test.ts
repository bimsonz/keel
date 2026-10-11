import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  alternativeDeclared,
  alternativeLanded,
  alternativesOf,
  areAlternatives,
  canonicalProposition,
  CoordinationEvent,
  exposure,
  type Intent,
  type LiveChange,
  type Proposition,
} from "../../../src/domain/coordination/index.ts";
import { type ChangeId, CommitSha, makeId } from "../../../src/domain/kernel/index.ts";
import { key } from "../../arbitraries/coordination.ts";
import { changeIds, graphPropositionArb, intentArb } from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

const idAt = (i: number): ChangeId => {
  const id = changeIds[i];
  if (id === undefined) throw new Error(`no change id ${i}`);
  return id;
};
const self = idAt(0);

/**
 * The claim an effect makes, written apart from the code under test: the
 * ordering rewrite, then subject, predicate, relation, value (a bound's unit
 * with it) and scope. Anchors, gloss, strength and citations are not part of it.
 */
const claimOf = (p: Proposition): string => {
  const c = canonicalProposition(p);
  return JSON.stringify([c.subject, c.predicate, c.relation, c.value, c.unit, c.scope]);
};
const claimsOf = (intent: Intent): ReadonlySet<string> =>
  new Set((intent.declaredEffects ?? []).map(claimOf));
const sameClaims = (a: Intent, b: Intent): boolean => {
  const mine = claimsOf(a);
  const theirs = claimsOf(b);
  return mine.size > 0 && mine.size === theirs.size && [...mine].every((c) => theirs.has(c));
};

const effectsArb = fc.uniqueArray(graphPropositionArb, {
  minLength: 1,
  maxLength: 3,
  selector: claimOf,
});

/** The same effects said another way: another order, repeats, and other anchors, glosses and strengths. */
const restated = (effects: readonly Proposition[]): fc.Arbitrary<readonly Proposition[]> =>
  fc
    .tuple(
      fc.shuffledSubarray([...effects], { minLength: effects.length }),
      fc.subarray([...effects]),
      fc.array(fc.constantFrom("bare", "anchored", "glossed", "should"), {
        minLength: effects.length * 2,
        maxLength: effects.length * 2,
      }),
    )
    .map(([shuffled, repeats, dress]) =>
      [...shuffled, ...repeats].map((p, i): Proposition => {
        const claim: Proposition = {
          subject: p.subject,
          predicate: p.predicate,
          relation: p.relation,
          value: p.value,
          ...(p.unit === undefined ? {} : { unit: p.unit }),
          ...(p.scope === undefined ? {} : { scope: p.scope }),
        };
        switch (dress[i]) {
          case "anchored":
            return {
              ...claim,
              anchors: [{ path: "src/elsewhere.ts", commit: CommitSha.make("b".repeat(40)) }],
            };
          case "glossed":
            return { ...claim, gloss: "said another way" };
          case "should":
            return { ...claim, strength: "should" };
          default:
            return claim;
        }
      }),
    );

type Kind = "restated" | "subset" | "superset" | "unrelated" | "none";

/** Two intents: the second restates the first's effects, drops one, adds one, is unrelated, or declares none. */
const pairArb: fc.Arbitrary<{ readonly a: Intent; readonly b: Intent; readonly kind: Kind }> = fc
  .record({
    a: intentArb,
    b: intentArb,
    effects: effectsArb,
    extra: graphPropositionArb,
    kind: fc.constantFrom<Kind>("restated", "subset", "superset", "unrelated", "none"),
  })
  .chain(({ a, b, effects, extra, kind }) => {
    const mine: Intent = { ...a, declaredEffects: effects };
    const theirs = (declaredEffects: readonly Proposition[]): Intent => ({ ...b, declaredEffects });
    const [first] = effects;
    return restated(effects).map((again) => {
      switch (kind) {
        case "restated":
          return { a: mine, b: theirs(again), kind };
        case "subset":
          return {
            a: mine,
            b: theirs(again.filter((p) => first === undefined || claimOf(p) !== claimOf(first))),
            kind,
          };
        case "superset":
          return { a: mine, b: theirs([...again, extra]), kind };
        case "none":
          return { a: mine, b: theirs([]), kind };
        default:
          return { a: mine, b, kind };
      }
    });
  });

const FRESH: Proposition = {
  subject: key("authz.permission-evaluation"),
  predicate: "freshness",
  relation: "is",
  value: "per-session",
};
const BOUND: Proposition = {
  subject: key("billing.invoice"),
  predicate: "bound",
  relation: "at-most",
  value: 5,
  unit: "ms",
};
const intent = (declaredEffects?: readonly Proposition[]): Intent => ({
  revision: 1,
  goal: "cache the session",
  footprint: [],
  premises: [],
  ...(declaredEffects === undefined ? {} : { declaredEffects }),
});
const live = (id: ChangeId, declaredEffects?: readonly Proposition[]): LiveChange => ({
  id,
  intent: intent(declaredEffects),
  derived: [],
});

describe("alternatives: changes with the same intent, which Keel shows to each other and never ranks", () => {
  it("[alternatives.equal-sets] two intents are alternatives exactly when their declared effects make the same non-empty set of claims, whatever the order, repeats, anchors or wording", () => {
    const reached = { restated: 0, subset: 0, superset: 0, unrelated: 0, none: 0 };
    fc.assert(
      fc.property(pairArb, ({ a, b, kind }) => {
        reached[kind] += 1;
        const expected = sameClaims(a, b);
        return (
          areAlternatives(a, b) === expected &&
          areAlternatives(b, a) === expected &&
          (kind !== "restated" || expected) &&
          (kind !== "none" || !expected)
        );
      }),
    );
    expect(Object.values(reached).every((n) => n > 0)).toBe(true);

    // The same claims, in another order, one repeated, pinned to other code and worded differently.
    expect(
      areAlternatives(
        intent([FRESH, BOUND]),
        intent([
          { ...BOUND, gloss: "invoices render fast", strength: "should" },
          { ...FRESH, anchors: [{ path: "src/authz.ts", commit: CommitSha.make("c".repeat(40)) }] },
          BOUND,
        ]),
      ),
    ).toBe(true);
    // One ordering named from either end is one claim.
    const before: Proposition = {
      subject: key("authz.revoked"),
      predicate: "ordering",
      relation: "before",
      value: "session.closed",
    };
    const after: Proposition = {
      subject: key("session.closed"),
      predicate: "ordering",
      relation: "after",
      value: "authz.revoked",
    };
    expect(areAlternatives(intent([before]), intent([after]))).toBe(true);
    expect(areAlternatives(intent([before]), intent([{ ...after, relation: "before" }]))).toBe(
      false,
    );
    // A partial overlap is not an alternative, from either side.
    expect(areAlternatives(intent([FRESH, BOUND]), intent([FRESH]))).toBe(false);
    expect(areAlternatives(intent([FRESH]), intent([FRESH, BOUND]))).toBe(false);
    // Another value, another scope or another unit is another claim.
    expect(areAlternatives(intent([FRESH]), intent([{ ...FRESH, value: "static" }]))).toBe(false);
    expect(areAlternatives(intent([FRESH]), intent([{ ...FRESH, scope: "env:prod" }]))).toBe(false);
    expect(areAlternatives(intent([BOUND]), intent([{ ...BOUND, unit: "s" }]))).toBe(false);
    // An intent that declares no effects is no one's alternative, not even another such intent's.
    expect(areAlternatives(intent([]), intent([]))).toBe(false);
    expect(areAlternatives(intent(), intent())).toBe(false);
    expect(areAlternatives(intent([FRESH]), intent())).toBe(false);
  });

  it("[alternatives.of-live] a change's alternatives are the live changes with the same intent, never itself, in the order they were given", () => {
    const others = changeIds.filter((id) => id !== self);
    fc.assert(
      fc.property(
        effectsArb.chain((effects) =>
          fc.record({
            mine: intentArb.map((i): Intent => ({ ...i, declaredEffects: effects })),
            order: fc.shuffledSubarray([self, ...others], { minLength: 1 }),
            same: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
            theirs: fc.array(intentArb, { minLength: 4, maxLength: 4 }),
            again: restated(effects),
          }),
        ),
        ({ mine, order, same, theirs, again }) => {
          const changes = order.map((id, i): LiveChange => {
            const other = theirs[i] ?? mine;
            return {
              id,
              // The change itself is in the index too, with the very same intent.
              intent:
                id === self
                  ? mine
                  : same[i] === true
                    ? { ...other, declaredEffects: again }
                    : other,
              derived: [],
            };
          });
          const expected = changes
            .filter((c) => c.id !== self && sameClaims(mine, c.intent))
            .map((c) => c.id);
          return (
            JSON.stringify(alternativesOf(self, mine, changes)) === JSON.stringify(expected) &&
            JSON.stringify(exposure(self, mine, changes).alternatives) === JSON.stringify(expected)
          );
        },
      ),
    );
    // Given newest first, they come back newest first: Keel does not sort them.
    const [second, third, fourth] = [idAt(1), idAt(2), idAt(3)];
    const index = [
      live(fourth, [FRESH]),
      live(self, [FRESH]),
      live(third, [BOUND]),
      live(second, [FRESH]),
    ];
    expect(alternativesOf(self, intent([FRESH]), index)).toEqual([fourth, second]);
    expect(exposure(self, intent([FRESH]), index).alternatives).toEqual([fourth, second]);
    expect(alternativesOf(self, intent([]), index)).toEqual([]);
  });

  it("[events.alternative-notices] each notice tells the change's agent to compare with the other change, rebase or withdraw, and names the right changes", () => {
    const project = makeId("prj", "0".repeat(25) + "9");
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...changeIds], { minLength: 2, maxLength: 2 }),
        fc.boolean(),
        ([changeId, otherId], landed) => {
          if (changeId === undefined || otherId === undefined) return false;
          const event = landed
            ? alternativeLanded(project, changeId, otherId)
            : alternativeDeclared(project, changeId, otherId);
          const named =
            event._tag === "AlternativeLanded" ? event.landedChangeId : event.alternativeId;
          const decoded = Schema.decodeUnknownSync(CoordinationEvent)(
            JSON.parse(JSON.stringify(Schema.encodeSync(CoordinationEvent)(event))),
          );
          return (
            event._tag === (landed ? "AlternativeLanded" : "AlternativeDeclared") &&
            event.projectId === project &&
            event.changeId === changeId &&
            named === otherId &&
            JSON.stringify(event.nextActions.map((n) => [n.kind, n.operationId, n.args])) ===
              JSON.stringify([
                ["read", "Changes_getChange", { changeId: otherId }],
                ["read", "nearby", { changeId }],
                ["call", "rebase", { changeId }],
                ["call", "abandon", { changeId }],
              ]) &&
            JSON.stringify(decoded) === JSON.stringify(event)
          );
        },
      ),
    );
    const mine = idAt(1);
    const theirs = idAt(2);
    expect(alternativeDeclared(project, mine, theirs)).toMatchObject({
      _tag: "AlternativeDeclared",
      projectId: project,
      changeId: mine,
      alternativeId: theirs,
    });
    expect(alternativeLanded(project, mine, theirs).nextActions.map((n) => n.operationId)).toEqual([
      "Changes_getChange",
      "nearby",
      "rebase",
      "abandon",
    ]);
  });
});
