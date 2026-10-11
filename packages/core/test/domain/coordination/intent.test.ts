import { describe, expect, it } from "vitest";
import {
  type Change,
  dedupePremises,
  evolveChange,
  type FootprintEntry,
  type Intent,
  IntentRevised,
  type IntentRevision,
  type Proposition,
  reviseIntent,
} from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  Glob,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { propositionArb } from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";

const T0 = Instant(1_760_000_000_000);
const CHANGE = makeId("chg", "0".repeat(25) + "1");
const AGENT = makeId("agt", "0".repeat(25) + "1");
const LEASE = makeId("lse", "0".repeat(25) + "1");

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const canonical = (value: unknown): string => canonicalJson(asJson(value));
/** A structurally equal copy: the rule compares propositions by value, never by reference. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const goals = ["cache the session", "revoke the token", "charge once"] as const;
const footprintArb: fc.Arbitrary<readonly FootprintEntry[]> = fc
  .subarray(["src/authz/check.ts", "src/authz/cache.ts", "src/billing/charge.ts"])
  .chain((paths) =>
    fc
      .tuple(
        ...paths.map(() => fc.constantFrom("edit" as const, "create" as const, "delete" as const)),
      )
      .map((ops) => paths.map((path, i) => ({ path: Glob.make(path), op: ops[i] ?? "edit" }))),
  );
const effectsArb = fc.array(propositionArb(), { maxLength: 2 });

/** An optional field, drawn present or absent (never present as undefined). */
const maybe = <V>(arb: fc.Arbitrary<V>): fc.Arbitrary<V | undefined> =>
  fc.option(arb, { nil: undefined });

const intentArb: fc.Arbitrary<Intent> = fc
  .tuple(
    fc.nat({ max: 40 }),
    fc.constantFrom(...goals),
    footprintArb,
    fc.array(propositionArb(), { maxLength: 4 }),
    maybe(effectsArb),
  )
  .map(([n, goal, footprint, premises, effects]) => ({
    revision: n + 1,
    goal,
    footprint,
    premises,
    ...(effects === undefined ? {} : { declaredEffects: effects }),
  }));

/**
 * A revision of `intent`: retractions of held premises (as copies) and of
 * premises it never held; additions of fresh premises, of held ones and of
 * repeats among themselves, so that every branch of the rule is common.
 */
const revisionArb = (intent: Intent): fc.Arbitrary<IntentRevision> =>
  fc
    .tuple(
      fc.subarray([...intent.premises]),
      fc.array(propositionArb(), { maxLength: 1 }),
      fc.subarray([...intent.premises]),
      fc.array(propositionArb(), { maxLength: 3 }),
      fc.boolean(),
      maybe(fc.constantFrom(...goals)),
      maybe(footprintArb),
      maybe(effectsArb),
    )
    .map(([retractHeld, retractOther, addHeld, fresh, repeat, goal, footprint, effects]) => ({
      revision: intent.revision + 1,
      premisesRetracted: [...retractHeld, ...retractOther].map(copy),
      premisesAdded: [...fresh, ...addHeld, ...(repeat ? fresh.slice(0, 1) : [])].map(copy),
      ...(goal === undefined ? {} : { goal }),
      ...(footprint === undefined ? {} : { footprint }),
      ...(effects === undefined ? {} : { declaredEffects: effects }),
    }));

const pairArb = intentArb.chain((intent) =>
  revisionArb(intent).map((revision) => ({ intent, revision })),
);

/** The rule as the docs state it (intent.ts), written out independently: a set of premises, by value. */
const expectedIntent = (intent: Intent, revision: IntentRevision): Intent => {
  const retracted = new Set(revision.premisesRetracted.map(canonical));
  const seen = new Set<string>();
  const premises = [
    ...intent.premises.filter((p) => !retracted.has(canonical(p))),
    ...revision.premisesAdded,
  ].filter((p) => {
    const k = canonical(p);
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const effects = revision.declaredEffects ?? intent.declaredEffects;
  return {
    revision: revision.revision,
    goal: revision.goal ?? intent.goal,
    footprint: revision.footprint ?? intent.footprint,
    premises,
    ...(effects === undefined ? {} : { declaredEffects: effects }),
  };
};

const sameIntent = (a: Intent, b: Intent): boolean =>
  canonical(a) === canonical(b) &&
  Object.hasOwn(a, "declaredEffects") === Object.hasOwn(b, "declaredEffects");

const changeIn = (state: "working" | "drifted" | "bounced", intent: Intent): Change => ({
  id: CHANGE,
  agentId: AGENT,
  origin: "agent",
  state,
  intent,
  lease: { id: LEASE, agentId: AGENT, renewedAt: T0, state: "active" },
  createdAt: T0,
});

describe("reviseIntent", () => {
  it("[intent.revise] a revision replaces what it gives, keeps what it doesn't, retracts by value, adds each premise once, and mutates nothing", () => {
    fc.assert(
      fc.property(pairArb, (generated) => {
        // A fresh copy each run: a fold that mutates its input must not grow fast-check's own values while it shrinks.
        const { intent, revision } = copy(generated);
        const before = canonical({ intent, revision });
        const revised = reviseIntent(intent, revision);
        return (
          sameIntent(revised, expectedIntent(intent, revision)) &&
          canonical({ intent, revision }) === before
        );
      }),
    );
    const [held, other] = fc.sample(propositionArb({ predicates: ["freshness"] }), {
      numRuns: 2,
      seed: 7,
    });
    if (held === undefined || other === undefined) throw new Error("sample");
    const intent: Intent = {
      revision: 3,
      goal: "cache the session",
      footprint: [{ path: Glob.make("src/authz/cache.ts"), op: "edit" }],
      premises: [held],
      declaredEffects: [other],
    };
    const revised = reviseIntent(intent, {
      revision: 4,
      premisesRetracted: [copy(held)],
      premisesAdded: [other, copy(other)],
    });
    expect(revised).toEqual({ ...intent, revision: 4, premises: [other] });
    expect(intent.premises).toEqual([held]);
  });

  it("[intent.dedupe] dedupePremises keeps the first of each premise by value, in order, and is idempotent", () => {
    fc.assert(
      fc.property(
        fc
          .array(propositionArb(), { maxLength: 4 })
          .chain((ps) =>
            fc
              .shuffledSubarray([...ps, ...ps.map(copy)])
              .map((all) => all as readonly Proposition[]),
          ),
        (premises) => {
          const once = dedupePremises(premises);
          const keys = once.map(canonical);
          const firsts = premises.filter(
            (p, i) => premises.findIndex((q) => canonical(q) === canonical(p)) === i,
          );
          return (
            new Set(keys).size === keys.length &&
            canonical(once) === canonical(firsts) &&
            canonical(dedupePremises(once)) === canonical(once)
          );
        },
      ),
    );
    const [p] = fc.sample(propositionArb(), { numRuns: 1, seed: 11 });
    if (p === undefined) throw new Error("sample");
    expect(dedupePremises([p, copy(p), p])).toEqual([p]);
  });

  it("[intent.evolve-agrees] the Change machine folds every IntentRevised it takes into exactly reviseIntent's intent", () => {
    fc.assert(
      fc.property(
        pairArb,
        fc.constantFrom("working" as const, "drifted" as const, "bounced" as const),
        (generated, state) => {
          const { intent, revision } = copy(generated);
          const event = IntentRevised.make({ changeId: CHANGE, ...revision });
          const evolved = evolveChange(changeIn(state, intent), { at: T0, payload: event });
          return (
            evolved.state === "working" && sameIntent(evolved.intent, reviseIntent(intent, event))
          );
        },
      ),
    );
    const [premise] = fc.sample(propositionArb(), { numRuns: 1, seed: 3 });
    if (premise === undefined) throw new Error("sample");
    const intent: Intent = { revision: 1, goal: "cache the session", footprint: [], premises: [] };
    const footprint = [{ path: Glob.make("src/authz/cache.ts"), op: "create" as const }];
    const evolved = evolveChange(changeIn("bounced", intent), {
      at: T0,
      payload: IntentRevised.make({
        changeId: CHANGE,
        revision: 2,
        goal: "revoke the token",
        footprint,
        premisesAdded: [premise],
        premisesRetracted: [],
        declaredEffects: [premise],
      }),
    });
    expect(evolved.intent).toEqual({
      revision: 2,
      goal: "revoke the token",
      footprint,
      premises: [premise],
      declaredEffects: [premise],
    });
  });
});
