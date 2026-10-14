/**
 * Deterministic effect derivation over parsed-source facts: which
 * stores are caches, how stale each can serve, when an event invalidates one,
 * which subjects it is put on, and what a change's effects then are.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DerivedEffect,
  deriveEffects,
  ExtractedEffect,
  type FreshnessValue,
  type Intent,
  isDeclared,
  isInvalidated,
  readClaim,
  SourceFacts,
  storeClaims,
  type SubjectAnchors,
  writeProposition,
} from "../../../src/domain/coordination/index.ts";
import { canonicalJson, Glob, type Json } from "../../../src/domain/kernel/index.ts";
import {
  BASE_COMMIT,
  baseOf,
  claimOf,
  claimsOf,
  edgeOf,
  entryOf,
  factsOf,
  HEAD_COMMIT,
  isCache,
  storeOf,
  SUBJECTS,
  subjectsOf,
  undecidedOf,
  type Unit,
  unitArb,
  unitsArb,
} from "../../arbitraries/syntax.ts";
import { fc } from "../../support/fast-check.ts";

const NOTHING: SourceFacts = {
  commit: BASE_COMMIT,
  stores: [],
  accesses: [],
  calls: [],
  subscriptions: [],
  impurities: [],
};
const intentWith = (declaredEffects: Intent["declaredEffects"] = []): Intent => ({
  revision: 1,
  goal: "speed things up",
  footprint: [{ path: Glob.make("src/**"), op: "edit" }],
  premises: [],
  declaredEffects,
});
const written = (value: FreshnessValue): string =>
  String(writeProposition(SUBJECTS[0], { predicate: "freshness", relation: "is", value }).value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A cache with every condition of the invalidation edge met, anchored on the first subject. */
const GOOD: Unit = {
  id: 0,
  holder: "instance",
  weak: false,
  wiring: "through",
  hops: 1,
  deferredHop: false,
  key: { parts: ["sessionId", "repoId"], session: true },
  expiry: "none",
  sub: {
    event: { name: "collaborator.removed", valid: true },
    via: { name: "subscribe", inProcess: true },
    async: false,
    hop: 0,
    deferredAt: "nowhere",
    target: "same",
  },
  anchor: "entry",
  subject: 0,
};
const withSub = (change: Partial<NonNullable<Unit["sub"]>>): Unit => ({
  ...GOOD,
  sub: GOOD.sub === undefined ? undefined : { ...GOOD.sub, ...change },
});

/** What `storeClaims` says about one unit's store: its written freshness, why it is undecided, or `none`. */
const claimed = (units: readonly Unit[], u: Unit): string => {
  const claim = storeClaims(factsOf(units)).find((c) => same(c.store, storeOf(u)));
  if (claim === undefined) return "none";
  return "freshness" in claim ? written(claim.freshness) : `undecided:${claim.undecided}`;
};
/** What `storeClaims` says about a unit on its own. */
const alone = (u: Unit): string => claimed([u], u);
/** The same list in another order: turned by `by`, and backwards when `by` is odd. */
const reorder = <T>(list: readonly T[], by: number): readonly T[] => {
  const cut = list.length === 0 ? 0 : by % list.length;
  const turned = [...list.slice(cut), ...list.slice(0, cut)];
  return by % 2 === 0 ? turned : turned.toReversed();
};
/** A tree's facts as they travel: encoded, then through JSON. */
const jsonOf = (facts: SourceFacts): Json =>
  JSON.parse(JSON.stringify(Schema.encodeSync(SourceFacts)(facts)));
const derive = (
  head: readonly Unit[],
  options: {
    readonly base?: readonly Unit[];
    readonly subjects?: readonly SubjectAnchors[];
    readonly intent?: Intent;
  } = {},
) =>
  deriveEffects({
    base: options.base === undefined ? NOTHING : factsOf(options.base, BASE_COMMIT),
    head: factsOf(head),
    subjects: options.subjects ?? subjectsOf(head),
    intent: options.intent ?? intentWith(),
  });
/** A derivation's effects as `subject|value`, sorted. */
const valuesOf = (d: ReturnType<typeof derive>): readonly string[] =>
  d.effects.map((e) => `${e.proposition.subject}|${String(e.proposition.value)}`).toSorted();
const undecidedIn = (d: ReturnType<typeof derive>): readonly string[] =>
  d.undecided.map((u) => `${u.subject}|${u.store.symbol}|${u.reason}`).toSorted();
const without = (all: readonly string[], held: readonly string[]): readonly string[] =>
  all.filter((x) => !held.includes(x));

describe("which stores are caches, and how stale each serves", () => {
  it("[derive.freshness-base] a store is a cache exactly when some symbol reads through it, and its bound follows where it lives, what expires its entries and what keys them", () => {
    fc.assert(
      fc.property(unitsArb, (units) =>
        units.every((u) => {
          const claim = storeClaims(factsOf(units)).find((c) => same(c.store, storeOf(u)));
          if (!isCache(u)) return claim === undefined;
          if (claim === undefined) return false;
          const base = baseOf(u);
          if ("undecided" in base)
            return "undecided" in claim && claim.undecided === base.undecided;
          return (
            "freshness" in claim &&
            written(isInvalidated(claim.freshness) ? claim.freshness.cached : claim.freshness) ===
              base.value
          );
        }),
      ),
    );
    const plain: Unit = { ...GOOD, sub: undefined };
    const says = (change: Partial<Unit>): string => {
      const u = { ...plain, ...change };
      return claimed([u], u);
    };
    expect(says({})).toBe("per-session");
    expect(says({ key: { parts: ["userId", "repoId"], session: false } })).toBe("static");
    expect(says({ key: { parts: ["sessionsCount"], session: false } })).toBe("static");
    expect(says({ key: { parts: ["c.var.session.id"], session: true } })).toBe("per-session");
    expect(says({ holder: "request" })).toBe("per-request");
    expect(says({ holder: "local" })).toBe("none");
    expect(says({ holder: "unknown" })).toBe("undecided:holder-unknown");
    expect(says({ expiry: 60 })).toBe("ttl:60");
    expect(says({ expiry: "unknown" })).toBe("undecided:expiry-unknown");
    // One write that never expires: the entries it makes are bounded by their key alone.
    expect(says({ expiry: "mixed" })).toBe("per-session");
    expect(says({ weak: true })).toBe("none");
    // A table that is only read, a log that is only written, a store someone else fills: not caches.
    expect(says({ wiring: "read-only" })).toBe("none");
    expect(says({ wiring: "write-only" })).toBe("none");
    expect(says({ wiring: "split" })).toBe("none");
  });

  it("[derive.invalidation-edge] a cache is invalidated on an event exactly when a handler registered for it on an in-process bus, not async, reaches a removal on that same store with nothing deferred on the way", () => {
    fc.assert(
      fc.property(unitsArb, (units) =>
        units.every((u) => {
          const claim = storeClaims(factsOf(units)).find((c) => same(c.store, storeOf(u)));
          if (claim === undefined || !("freshness" in claim)) return true;
          const base = baseOf(u);
          const edge = "value" in base && base.value !== "per-request" ? edgeOf(u) : undefined;
          const events = isInvalidated(claim.freshness) ? claim.freshness.invalidatedOn : [];
          return (
            same(events, edge === undefined ? [] : [edge]) &&
            same(
              claim.subscribedIn.map((s) => s.symbol),
              edge === undefined ? [] : [`wire${u.id}`],
            )
          );
        }),
      ),
    );
    expect(alone(GOOD)).toBe("per-session invalidated-on collaborator.removed");
    expect(alone(withSub({ hop: 1 }))).toBe("per-session invalidated-on collaborator.removed");
    // Each condition on its own: without it the cache is plainly per-session.
    expect(alone({ ...GOOD, sub: undefined })).toBe("per-session");
    expect(alone(withSub({ async: true }))).toBe("per-session");
    expect(alone(withSub({ via: { name: "enqueue", inProcess: false } }))).toBe("per-session");
    expect(alone(withSub({ event: { name: "CollaboratorRemoved", valid: false } }))).toBe(
      "per-session",
    );
    expect(alone(withSub({ deferredAt: "call" }))).toBe("per-session");
    expect(alone(withSub({ deferredAt: "access" }))).toBe("per-session");
    expect(alone(withSub({ target: "other" }))).toBe("per-session");
    expect(alone(withSub({ target: "none" }))).toBe("per-session");
    // An eviction the store defines but the handler never calls is no edge.
    const wired = factsOf([GOOD]);
    const uncalled = { ...wired, calls: wired.calls.filter((c) => !c.from.symbol.includes("~")) };
    expect(wired.calls.length - uncalled.calls.length).toBe(1);
    expect(
      storeClaims(uncalled).map((c) => ("freshness" in c ? written(c.freshness) : "")),
    ).toEqual(["per-session"]);
    // A request's memo is already as fresh as an eviction would make it.
    expect(alone({ ...GOOD, holder: "request" })).toBe("per-request");

    // Two events, registered twice over and out of order: each once, sorted.
    const facts = factsOf([GOOD]);
    const [first] = facts.subscriptions;
    const again = facts.subscriptions.flatMap((s) => [
      { ...s, event: "role.changed" },
      { ...s, event: "collaborator.removed" },
    ]);
    const twice = storeClaims({ ...facts, subscriptions: [...again, ...facts.subscriptions] });
    expect(first?.event).toBe("collaborator.removed");
    expect(twice.map((c) => ("freshness" in c ? written(c.freshness) : c.undecided))).toEqual([
      "per-session invalidated-on collaborator.removed,role.changed",
    ]);
  });
});

/** Units no subject's anchors reach, numbered clear of the units they sit beside. */
const decoysArb: fc.Arbitrary<readonly Unit[]> = fc
  .tuple(
    unitArb(10),
    unitArb(11),
    fc.constantFrom<Unit["anchor"]>("sibling", "elsewhere", "prefix", "none"),
  )
  .map(([a, b, anchor]) => [
    { ...a, anchor },
    { ...b, anchor },
  ]);

describe("which subject a cache is put on", () => {
  it("[derive.attribution-anchors-only] an effect names a subject exactly when one of that subject's anchors covers a reader of the cache or the store itself, and code no anchor reaches never changes a subject's effects", () => {
    fc.assert(
      fc.property(unitsArb, (units) => {
        const derived = derive(units);
        return (
          same(valuesOf(derived), claimsOf(units, units)) &&
          same(undecidedIn(derived), undecidedOf(units, units))
        );
      }),
    );
    fc.assert(
      fc.property(unitsArb, decoysArb, (units, decoys) => {
        const apart = derive(units);
        const beside = derive([...units, ...decoys], {
          subjects: subjectsOf([...units, ...decoys]),
        });
        return (
          same(valuesOf(apart), valuesOf(beside)) && same(undecidedIn(apart), undecidedIn(beside))
        );
      }),
    );
    const plain: Unit = { ...GOOD, sub: undefined };
    const on = (anchor: Unit["anchor"], subject: Unit["subject"] = 0) =>
      valuesOf(derive([{ ...plain, anchor, subject }]));
    expect(on("entry")).toEqual([`${SUBJECTS[0]}|per-session`]);
    // An anchor on the cache's own class, or on its whole file, is about the cache too.
    expect(on("class")).toEqual([`${SUBJECTS[0]}|per-session`]);
    expect(on("path")).toEqual([`${SUBJECTS[0]}|per-session`]);
    // A sibling symbol in the same file that only reads; the same name in another file; a name that only starts alike.
    expect(on("sibling")).toEqual([]);
    expect(on("elsewhere")).toEqual([]);
    expect(on("prefix")).toEqual([]);
    expect(on("none")).toEqual([]);
    // A sibling subject's anchor puts the cache on the sibling, and on nothing else.
    expect(on("entry", 1)).toEqual([`${SUBJECTS[1]}|per-session`]);
    // A subject with no anchor on this code gets nothing, however near its key.
    expect(
      valuesOf(
        derive([plain], {
          subjects: [
            ...subjectsOf([plain]),
            { subject: SUBJECTS[1], anchors: [] },
            {
              subject: SUBJECTS[2],
              anchors: [{ path: "src/unrelated.ts", commit: BASE_COMMIT }],
            },
          ],
        }),
      ),
    ).toEqual([`${SUBJECTS[0]}|per-session`]);
    // Two rows for one subject are one subject.
    expect(
      valuesOf(derive([plain], { subjects: [...subjectsOf([plain]), ...subjectsOf([plain])] })),
    ).toEqual([`${SUBJECTS[0]}|per-session`]);
  });
});

describe("a change's effects", () => {
  it("[derive.change-only] the effects are head's claims that base did not make: a tree compared with itself derives nothing, and a claim both trees make is not the change's", () => {
    fc.assert(
      fc.property(unitsArb, unitsArb, (before, after) => {
        const anchored = [...before, ...after];
        const derived = derive(after, { base: before, subjects: subjectsOf(anchored) });
        return (
          same(valuesOf(derived), without(claimsOf(after, anchored), claimsOf(before, anchored))) &&
          same(
            undecidedIn(derived),
            without(undecidedOf(after, anchored), undecidedOf(before, anchored)),
          )
        );
      }),
    );
    fc.assert(
      fc.property(unitsArb, (units) =>
        same(derive(units, { base: units }), { effects: [], undecided: [] }),
      ),
    );
    const plain: Unit = { ...GOOD, sub: undefined };
    // Adding the eviction, and taking it away again, are each a change's effect; leaving it alone is not.
    expect(valuesOf(derive([GOOD], { base: [plain] }))).toEqual([
      `${SUBJECTS[0]}|per-session invalidated-on collaborator.removed`,
    ]);
    expect(valuesOf(derive([plain], { base: [GOOD] }))).toEqual([`${SUBJECTS[0]}|per-session`]);
    expect(valuesOf(derive([GOOD], { base: [GOOD] }))).toEqual([]);
    expect(valuesOf(derive([plain]))).toEqual([`${SUBJECTS[0]}|per-session`]);
    // A cache the change removes derives nothing.
    expect(derive([], { base: [plain], subjects: subjectsOf([plain]) })).toEqual({
      effects: [],
      undecided: [],
    });
  });

  it("[derive.ruling-shape] every derived effect is a ruling that decodes as an extractor's, reads on its lattice, rests on symbols of the head tree, and says whether the intent declared it", () => {
    const perSession = { subject: SUBJECTS[0], predicate: "freshness", relation: "is" } as const;
    const intents = [
      intentWith(),
      intentWith([{ ...perSession, value: "per-session" }]),
      intentWith([{ ...perSession, value: "static" }]),
      intentWith([{ ...perSession, relation: "at-most", value: "static" }]),
    ];
    let seen = 0;
    fc.assert(
      fc.property(unitsArb, fc.constantFrom(...intents), (units, intent) => {
        const head = factsOf(units);
        const symbols = new Set(
          [
            ...head.stores.map((s) => s.at),
            ...head.accesses.map((a) => a.in),
            ...head.calls.flatMap((c) => [c.from, c.to]),
            ...head.subscriptions.map((s) => s.in),
          ].map((ref) => `${ref.path}#${ref.symbol}`),
        );
        return derive(units, { intent }).effects.every((effect) => {
          seen++;
          const wire: unknown = JSON.parse(
            JSON.stringify(Schema.encodeSync(DerivedEffect)(effect)),
          );
          const back = Schema.decodeUnknownResult(ExtractedEffect)(wire);
          return (
            Result.isSuccess(back) &&
            same(back.success, effect) &&
            effect.method === "extractor" &&
            effect.evidenceClass === "ruling" &&
            !("p" in effect) &&
            !("contradicts" in effect) &&
            effect.anchors.length > 0 &&
            same(effect.proposition.anchors, effect.anchors) &&
            effect.anchors.every(
              (a) => a.commit === HEAD_COMMIT && symbols.has(`${a.path}#${a.symbol ?? ""}`),
            ) &&
            Result.isSuccess(readClaim(effect.proposition)) &&
            effect.declared === isDeclared(intent, effect.proposition)
          );
        });
      }),
    );
    expect(seen).toBeGreaterThan(0);
    const [undeclared] = derive([GOOD]).effects;
    expect(undeclared).toMatchObject({
      method: "extractor",
      evidenceClass: "ruling",
      declared: false,
    });
    // The store, the anchored reader and the place the eviction is subscribed, at head's commit.
    expect(undeclared?.anchors).toEqual([
      { path: "src/u0.ts", symbol: "Cache0.#map", commit: HEAD_COMMIT },
      { path: "src/u0.ts", symbol: "entry0", commit: HEAD_COMMIT },
      { path: "src/u0.ts", symbol: "wire0", commit: HEAD_COMMIT },
    ]);
    const plain: Unit = { ...GOOD, sub: undefined };
    const declares = (intent: Intent) => derive([plain], { intent }).effects.map((e) => e.declared);
    expect(declares(intents[0] ?? intentWith())).toEqual([false]);
    expect(declares(intents[1] ?? intentWith())).toEqual([true]);
    // Declaring a looser bound covers it; declaring a different value does not.
    expect(declares(intents[3] ?? intentWith())).toEqual([true]);
    expect(declares(intents[2] ?? intentWith())).toEqual([false]);
    expect(entryOf(plain).symbol).toBe("entry0");
  });

  it("[derive.deterministic] the same facts in any order derive the same claims and the same effects, in the same order", () => {
    fc.assert(
      fc.property(unitsArb, fc.nat(50), (units, by) => {
        const head = factsOf(units);
        const shuffled: SourceFacts = {
          commit: head.commit,
          stores: reorder(head.stores, by),
          accesses: reorder(head.accesses, by + 1),
          calls: reorder(head.calls, by + 2),
          subscriptions: reorder(head.subscriptions, by + 3),
          impurities: reorder(head.impurities, by + 4),
        };
        const subjects = subjectsOf(units);
        const input = { base: NOTHING, intent: intentWith() };
        return (
          same(storeClaims(head), storeClaims(shuffled)) &&
          same(
            deriveEffects({ ...input, head, subjects }),
            deriveEffects({ ...input, head: shuffled, subjects: reorder(subjects, by + 4) }),
          )
        );
      }),
    );
    // Three caches on three subjects, given backwards: the effects come out by subject all the same.
    const three: readonly Unit[] = ([2, 1, 0] as const).map((subject, id) => ({
      ...GOOD,
      sub: undefined,
      id,
      subject,
    }));
    const forwards = derive(three);
    const backwards = deriveEffects({
      base: NOTHING,
      head: factsOf(three.toReversed()),
      subjects: subjectsOf(three).toReversed(),
      intent: intentWith(),
    });
    expect(forwards.effects.map((e) => e.proposition.subject)).toEqual([...SUBJECTS].toSorted());
    expect(backwards).toEqual(forwards);
    expect(storeClaims(factsOf(three.toReversed()))).toEqual(storeClaims(factsOf(three)));
    // Two symbols read through one cache: whichever calls first in the facts, the readers and the anchors come out alike.
    const one = factsOf([{ ...GOOD, sub: undefined, hops: 0, anchor: "path" }]);
    const both = [
      ...one.calls,
      ...one.calls
        .filter((c) => c.from.symbol === "entry0")
        .map((c) => ({ ...c, from: { ...c.from, symbol: "zebra0" } })),
    ];
    const readersOf = (calls: SourceFacts["calls"]) =>
      storeClaims({ ...one, calls }).map((claim) => claim.readers.map((r) => r.symbol));
    const anchorsOf = (calls: SourceFacts["calls"]) =>
      deriveEffects({
        base: NOTHING,
        head: { ...one, calls },
        subjects: subjectsOf([{ ...GOOD, anchor: "path" }]),
        intent: intentWith(),
      }).effects.map((e) => e.anchors.map((a) => a.symbol));
    expect(readersOf(both)).toEqual([["entry0", "zebra0"]]);
    expect(readersOf(both.toReversed())).toEqual([["entry0", "zebra0"]]);
    expect(anchorsOf(both)).toEqual([["Cache0.#map", "entry0", "zebra0"]]);
    expect(anchorsOf(both.toReversed())).toEqual(anchorsOf(both));
  });
});

describe("parsed facts on the wire", () => {
  it("[syntax.facts-wire] a tree's facts survive encode, JSON and decode unchanged, and a fact with a field missing, an expiry below zero or an impurity of no kind Keel names does not decode", () => {
    const decode = Schema.decodeUnknownResult(SourceFacts);
    fc.assert(
      fc.property(unitsArb, (units) => {
        const facts = factsOf(units);
        const back = decode(jsonOf(facts));
        // Field order is not part of a fact: compare the two in canonical JSON.
        return (
          Result.isSuccess(back) &&
          canonicalJson(jsonOf(back.success)) === canonicalJson(jsonOf(facts))
        );
      }),
    );
    const facts: SourceFacts = {
      ...factsOf([{ ...GOOD, expiry: "unknown" }]),
      impurities: [{ in: entryOf(GOOD), what: "console.info", kind: "output" }],
    };
    const wire = Schema.encodeSync(SourceFacts)(facts);
    const dropping = (
      list: "calls" | "accesses" | "subscriptions" | "impurities",
      field: string,
    ): unknown => ({
      ...wire,
      [list]: wire[list].map((fact) =>
        Object.fromEntries(Object.entries(fact).filter(([name]) => name !== field)),
      ),
    });
    expect(Result.isSuccess(decode(wire))).toBe(true);
    expect(facts.accesses.some((a) => a.expiry === "unknown")).toBe(true);
    expect(Result.isSuccess(decode(dropping("calls", "deferred")))).toBe(false);
    expect(Result.isSuccess(decode(dropping("accesses", "deferred")))).toBe(false);
    expect(Result.isSuccess(decode(dropping("subscriptions", "async")))).toBe(false);
    expect(Result.isSuccess(decode(dropping("impurities", "kind")))).toBe(false);
    expect(
      Result.isSuccess(
        decode({ ...wire, impurities: wire.impurities.map((i) => ({ ...i, kind: "slow" })) }),
      ),
    ).toBe(false);
    const { impurities: _dropped, ...noImpurities } = wire;
    expect(Result.isSuccess(decode(noImpurities))).toBe(false);
    expect(
      Result.isSuccess(
        decode({
          ...wire,
          accesses: wire.accesses.map((a) => ({ ...a, expiry: { seconds: -1 } })),
        }),
      ),
    ).toBe(false);
    expect(claimOf(GOOD)).toEqual({ value: "per-session invalidated-on collaborator.removed" });
  });
});
