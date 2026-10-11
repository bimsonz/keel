import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  canonicalProposition,
  type Change,
  type ChangeCommand,
  compare,
  decideChange,
  type DerivedEffect,
  evolveChange,
  keyOf,
  type Preflight,
  type Proposition,
  readClaim,
  SubjectKey,
} from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  CommitSha,
  ContentHash,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { latticePredicates, propositionArb } from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const CHANGE = makeId("chg", ulid(1));
const AGENT = makeId("agt", ulid(1));
const LEASE = makeId("lse", ulid(1));
const SHA = CommitSha.make("a".repeat(40));
const preflight: Preflight = {
  neighbours: [],
  contradictions: [],
  precedents: [],
  suggestedMove: "proceed",
};

/** Compared by value, whatever order a schema rebuilt the keys in. */
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null));
const json = (value: unknown): string => canonicalJson(asJson(value));

type Side = "before" | "after";
const flip = (side: Side): Side => (side === "before" ? "after" : "before");

/** `subject <side> other`: an ordering written from `subject`. */
const ordering = (
  subject: string,
  side: Side,
  other: string,
  details: Partial<Proposition> = {},
): Proposition => ({
  ...details,
  subject: SubjectKey.make(subject),
  predicate: "ordering",
  relation: side,
  value: other,
});

// MFP 0.2's event names (conformance/0.2/lattices/comparison.json), and some nested keys.
const eventArb = fc.constantFrom("deploy", "migrate", "seed", "db", "db.migrate", "authz.revoke");
const pairArb = fc
  .tuple(eventArb, eventArb)
  .filter(([x, y]) => x !== y)
  .map(([x, y]) => [x, y] as const);
const sideArb = fc.constantFrom<Side>("before", "after");
const detailsArb: fc.Arbitrary<Partial<Proposition>> = fc
  .record(
    {
      scope: fc.constantFrom("env:prod", "env:prod|staging;tenant:t1"),
      anchors: fc.constant([{ path: "src/deploy.ts", commit: SHA }]),
      gloss: fc.constant("migrations run first"),
      strength: fc.constantFrom("must" as const, "should" as const),
    },
    { requiredKeys: [] },
  )
  .map((d) => d);
/** An ordering written from either of its events, with or without its other fields. */
const orderingArb: fc.Arbitrary<Proposition> = fc
  .tuple(pairArb, sideArb, detailsArb)
  .map(([[x, y], side, details]) => ordering(x, side, y, details));
const otherArb = propositionArb({
  predicates: latticePredicates.filter((p) => p !== "ordering"),
});
const anyArb = fc.oneof(orderingArb, otherArb);

/** What the docs call canonical: an ordering's subject is the lesser of its two events. */
const isCanonical = (p: Proposition): boolean =>
  p.predicate !== "ordering" || typeof p.value !== "string" || p.subject < p.value;

const pairOf = (p: Proposition) => {
  const read = readClaim(p);
  return Result.isSuccess(read) ? read.success.claim.value : undefined;
};

const without = (p: Proposition) => {
  const { subject: _s, relation: _r, value: _v, ...rest } = p;
  return rest;
};

describe("an ordering's canonical form", () => {
  it("[ordering.canonical-form] an ordering is written from its lesser event, means the same pair, keeps its other fields, and is canonical once; nothing else changes", () => {
    let rewritten = 0;
    fc.assert(
      fc.property(orderingArb, (p) => {
        const c = canonicalProposition(p);
        if (c.subject !== p.subject) rewritten++;
        return (
          isCanonical(c) &&
          json(pairOf(c)) === json(pairOf(p)) &&
          pairOf(c) !== undefined &&
          json(without(c)) === json(without(p)) &&
          json(canonicalProposition(c)) === json(c)
        );
      }),
    );
    fc.assert(fc.property(otherArb, (p) => json(canonicalProposition(p)) === json(p)));
    expect(rewritten).toBeGreaterThan(0);
    expect(
      canonicalProposition(ordering("migrate", "before", "deploy", { scope: "env:prod" })),
    ).toEqual(ordering("deploy", "after", "migrate", { scope: "env:prod" }));
  });

  it("[ordering.reversed-meets] a premise and an effect written from opposite events meet on one subject, and compare as they would written from the same event", () => {
    fc.assert(
      fc.property(pairArb, sideArb, sideArb, ([x, y], premiseSide, effectSide) => {
        const premise = ordering(x, premiseSide, y);
        const fromOther = ordering(y, effectSide, x);
        const fromSame = ordering(x, flip(effectSide), y);
        const [p, e] = [canonicalProposition(premise), canonicalProposition(fromOther)];
        return (
          keyOf(p) === keyOf(e) && compare(p, e).outcome === compare(premise, fromSame).outcome
        );
      }),
    );
    // MFP 0.2: "the same ordering written from the other event" holds.
    const premise = canonicalProposition(ordering("migrate", "before", "deploy"));
    expect(
      compare(premise, canonicalProposition(ordering("deploy", "after", "migrate"))).outcome,
    ).toBe("compatible");
    // MFP 0.2: "an ordering reversed, written from the other event" contradicts.
    expect(
      compare(premise, canonicalProposition(ordering("deploy", "before", "migrate"))).outcome,
    ).toBe("contradicts");
  });
});

const working: Change = {
  id: CHANGE,
  agentId: AGENT,
  origin: "agent",
  state: "working",
  intent: { revision: 1, goal: "migrate first", footprint: [], premises: [] },
  lease: { id: LEASE, agentId: AGENT, renewedAt: T0, state: "active" },
  createdAt: T0,
  workspaceId: makeId("wsp", ulid(1)),
};
const derived = (proposition: Proposition): DerivedEffect => ({
  proposition,
  anchors: [{ path: "src/deploy.ts", commit: SHA }],
  declared: false,
  method: "extractor",
  evidenceClass: "ruling",
});

const decided = (state: Change | undefined, command: ChangeCommand) =>
  Result.getOrThrow(decideChange(state, command, { now: T0, changeId: CHANGE }));

/** Every proposition an emitted event carries. */
const carried = (events: ReturnType<typeof decided>): readonly Proposition[] =>
  events.flatMap((e) => {
    switch (e._tag) {
      case "IntentDeclared":
        return [...e.premises, ...(e.declaredEffects ?? [])];
      case "IntentRevised":
        return [...e.premisesAdded, ...e.premisesRetracted, ...(e.declaredEffects ?? [])];
      case "EffectsDerived":
        return e.effects.map((d) => d.proposition);
      default:
        return [];
    }
  });

const canon = (ps: readonly Proposition[]): readonly Proposition[] => ps.map(canonicalProposition);

const same = (a: readonly Proposition[], b: readonly Proposition[]): boolean => json(a) === json(b);

describe("propositions entering Keel", () => {
  it("[ordering.declared-canonical] declare, revise, rely and derive commit their propositions canonical, so a retraction from the other event still retracts", () => {
    const listArb = fc.array(anyArb, { maxLength: 3 });
    fc.assert(
      fc.property(listArb, listArb, listArb, anyArb, (premises, effects, retracted, relied) => {
        const declared = decided(undefined, {
          _tag: "Declare",
          changeId: CHANGE,
          agentId: AGENT,
          origin: "agent",
          goal: "migrate first",
          footprint: [],
          premises,
          declaredEffects: effects,
          leaseId: LEASE,
          preflight,
        });
        const revised = decided(working, {
          _tag: "Revise",
          leaseId: LEASE,
          ifMatchRevision: 1,
          premisesAdded: premises,
          premisesRetracted: retracted,
          declaredEffects: effects,
          preflight,
        });
        const rely = decided(working, { _tag: "Rely", leaseId: LEASE, premise: relied, preflight });
        const compiled = decided(
          { ...working, state: "deriving" },
          {
            _tag: "CompilePlan",
            derivation: { effects: effects.map(derived), derivationRef: "derivation-1" },
            drift: [],
            planHash: ContentHash.make(`sha256:${"0".repeat(64)}`),
            steps: 1,
            costEstimate: 1,
          },
        );
        return (
          same(carried(declared), canon([...premises, ...effects])) &&
          same(carried(revised), canon([...premises, ...retracted, ...effects])) &&
          same(carried(rely), canon([relied])) &&
          same(carried(compiled), canon(effects)) &&
          [declared, revised, rely, compiled].every((events) => carried(events).every(isCanonical))
        );
      }),
    );
    const held = canonicalProposition(ordering("migrate", "before", "deploy"));
    const holding: Change = { ...working, intent: { ...working.intent, premises: [held] } };
    const retraction = decided(holding, {
      _tag: "Revise",
      leaseId: LEASE,
      ifMatchRevision: 1,
      premisesAdded: [],
      premisesRetracted: [ordering("migrate", "before", "deploy")],
      preflight,
    });
    const after = retraction.reduce((s, payload) => evolveChange(s, { at: T0, payload }), holding);
    expect(after.intent.premises).toEqual([]);
  });
});

describe("reading an ordering", () => {
  it("[claim.ordering-value-is-key] an ordering whose other event is not an event key is refused, never read", () => {
    for (const value of ["Deploy", "a b", "", "deploy.", "-deploy", "db..migrate"]) {
      expect(Result.isFailure(readClaim(ordering("migrate", "before", value)))).toBe(true);
    }
    expect(Result.isSuccess(readClaim(ordering("migrate", "before", "db.migrate")))).toBe(true);
  });

  it("[claim.ordering-distinct] an ordering of an event against itself is refused: there is no lesser event, and it contradicts itself", () => {
    for (const event of ["deploy", "db.migrate"]) {
      expect(Result.isFailure(readClaim(ordering(event, "before", event)))).toBe(true);
      expect(Result.isFailure(readClaim(ordering(event, "after", event)))).toBe(true);
    }
    expect(canonicalProposition(ordering("deploy", "before", "deploy"))).toEqual(
      ordering("deploy", "before", "deploy"),
    );
  });
});
