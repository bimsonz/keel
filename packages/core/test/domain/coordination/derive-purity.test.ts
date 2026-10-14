/**
 * The purity rule: a change makes a function impure when a symbol an anchor
 * covers takes an impure step at head, itself or through the calls it makes,
 * and took none at base. Each case is the smallest set of facts that shows
 * one part of it; the property holds the rule against a fixpoint written
 * apart from it.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  deriveEffects,
  ExtractedEffect,
  type Impurity,
  type Intent,
  type SourceFacts,
  SubjectKey,
  type SubjectAnchors,
  type SymbolRef,
  writeProposition,
} from "../../../src/domain/coordination/index.ts";
import { type Anchor, Glob } from "../../../src/domain/kernel/index.ts";
import { BASE_COMMIT, HEAD_COMMIT } from "../../arbitraries/syntax.ts";
import { fc } from "../../support/fast-check.ts";

const PRICE = Schema.decodeUnknownSync(SubjectKey)("bench.p2.price");
const OTHER = Schema.decodeUnknownSync(SubjectKey)("bench.p2.label");
const FILE = "bench/p2.ts";
const LOG = "bench/log.ts";
const at = (path: string, symbol: string): SymbolRef => ({ path, symbol });
const price = at(FILE, "price");
const label = at(FILE, "label");
const log = at(LOG, "log");

type Tree = Omit<SourceFacts, "commit">;
const EMPTY: Tree = { stores: [], accesses: [], calls: [], subscriptions: [], impurities: [] };
const impure = (where: SymbolRef, what = "console.info", kind: Impurity["kind"] = "output") => ({
  in: where,
  what,
  kind,
});
const intent = (declaredEffects: Intent["declaredEffects"] = []): Intent => ({
  revision: 1,
  goal: "log what is priced",
  footprint: [{ path: Glob.make("bench/**"), op: "edit" }],
  premises: [],
  declaredEffects,
});
const onPrice: SubjectAnchors = {
  subject: PRICE,
  anchors: [{ path: FILE, symbol: "price", commit: BASE_COMMIT }],
};
const derive = (
  base: Partial<Tree>,
  head: Partial<Tree>,
  subjects: readonly SubjectAnchors[] = [onPrice],
  declared: Intent["declaredEffects"] = [],
) =>
  deriveEffects({
    base: { ...EMPTY, ...base, commit: BASE_COMMIT },
    head: { ...EMPTY, ...head, commit: HEAD_COMMIT },
    subjects,
    intent: intent(declared),
  });
/** Each effect as `subject purity is value @ anchors | gloss`. */
const said = (d: ReturnType<typeof derive>): readonly string[] =>
  d.effects.map(
    (e) =>
      `${e.proposition.subject} ${e.proposition.predicate} ${e.proposition.relation} ${String(e.proposition.value)} @ ${e.anchors
        .map((a) => `${a.path}#${a.symbol ?? ""}`)
        .join(",")} | ${e.proposition.gloss ?? ""}`,
  );

const PATHS = ["a.ts", "b.ts"] as const;
const NAMES = ["f", "g", "C", "C.m", "C.n"] as const;
const refArb = fc.record({ path: fc.constantFrom(...PATHS), symbol: fc.constantFrom(...NAMES) });
const treeArb = fc.record({
  calls: fc.array(fc.record({ from: refArb, to: refArb, deferred: fc.boolean() }), {
    maxLength: 8,
  }),
  impurities: fc.array(
    fc.record({
      in: refArb,
      what: fc.constantFrom("console.log", "fetch", "hits"),
      kind: fc.constantFrom("output" as const, "network" as const, "module-state" as const),
    }),
    { maxLength: 3 },
  ),
});
const anchorArb: fc.Arbitrary<Anchor> = fc.record(
  {
    path: fc.constantFrom<string>(...PATHS),
    symbol: fc.constantFrom<string>(...NAMES),
    commit: fc.constant(BASE_COMMIT),
  },
  { requiredKeys: ["path", "commit"] },
);
const subjectsArb = fc.array(fc.array(anchorArb, { minLength: 1, maxLength: 3 }), {
  minLength: 1,
  maxLength: 3,
});
const keyOf = (r: SymbolRef) => `${r.path}#${r.symbol}`;
/** Every symbol that reaches an impure step, by a fixpoint over the calls: written apart from the rule. */
const reachingOf = (tree: Partial<Tree>): ReadonlySet<string> => {
  const found = new Set((tree.impurities ?? []).map((i) => keyOf(i.in)));
  for (let grew = true; grew;) {
    grew = false;
    for (const call of tree.calls ?? [])
      if (found.has(keyOf(call.to)) && !found.has(keyOf(call.from))) {
        found.add(keyOf(call.from));
        grew = true;
      }
  }
  return found;
};
const coveredBy = (anchor: Anchor, ref: SymbolRef) =>
  anchor.path === ref.path &&
  (anchor.symbol === undefined ||
    anchor.symbol === ref.symbol ||
    ref.symbol.startsWith(`${anchor.symbol}.`));
/** The same list in another order. */
const turned = <T>(list: readonly T[], by: number): readonly T[] => {
  const cut = list.length === 0 ? 0 : by % list.length;
  return [...list.slice(cut), ...list.slice(0, cut)].toReversed();
};

describe("the purity rule", () => {
  it("[derive.purity-gained] a covered symbol that takes an impure step at head and took none at base makes its subject's purity false, as an undeclared ruling on that symbol at head; nothing else does", () => {
    // lg50a's effect pair: `price` gains a `console.info`.
    const planted = derive({}, { impurities: [impure(price)] });
    expect(said(planted)).toEqual([
      "bench.p2.price purity is false @ bench/p2.ts#price | price calls console.info",
    ]);
    const [effect] = planted.effects;
    expect(effect?.anchors).toEqual([{ path: FILE, symbol: "price", commit: HEAD_COMMIT }]);
    expect(effect?.proposition.anchors).toEqual(effect?.anchors);
    expect(effect?.method).toBe("extractor");
    expect(effect?.evidenceClass).toBe("ruling");
    expect(effect?.declared).toBe(false);
    expect(Schema.decodeUnknownSync(ExtractedEffect)(effect)).toEqual(effect);
    expect(planted.undecided).toEqual([]);

    // Declared when the intent said so.
    const declaring = derive(
      {},
      { impurities: [impure(price)] },
      [onPrice],
      [writeProposition(PRICE, { predicate: "purity", relation: "is", value: false })],
    );
    expect(declaring.effects.map((e) => e.declared)).toEqual([true]);

    // The decoy rewrites `price` purely: nothing.
    expect(said(derive({}, {}))).toEqual([]);
    // Already impure at base, and more so at head: nothing new.
    expect(
      said(
        derive(
          { impurities: [impure(price)] },
          { impurities: [impure(price), impure(price, "fetch", "network")] },
        ),
      ),
    ).toEqual([]);
    // An impure step in a symbol no anchor covers: nothing.
    expect(said(derive({}, { impurities: [impure(label)] }))).toEqual([]);
    // A whole-file anchor covers a symbol the change adds.
    const wholeFile: SubjectAnchors = {
      subject: PRICE,
      anchors: [{ path: FILE, commit: BASE_COMMIT }],
    };
    expect(
      said(
        derive({}, { impurities: [impure(at(FILE, "audit"), "fetch", "network")] }, [wholeFile]),
      ),
    ).toEqual(["bench.p2.price purity is false @ bench/p2.ts#audit | audit calls fetch"]);
    // An anchor on a class covers its methods.
    const onClass: SubjectAnchors = {
      subject: PRICE,
      anchors: [{ path: FILE, symbol: "Pricer", commit: BASE_COMMIT }],
    };
    expect(
      said(
        derive({}, { impurities: [impure(at(FILE, "Pricer.quote"), "hits", "module-state")] }, [
          onClass,
        ]),
      ),
    ).toEqual([
      "bench.p2.price purity is false @ bench/p2.ts#Pricer.quote | Pricer.quote writes hits",
    ]);
    // Per symbol: a subject already impure through `label` still hears that `price` became so.
    const both: SubjectAnchors = { subject: PRICE, anchors: [{ path: FILE, commit: BASE_COMMIT }] };
    expect(
      said(
        derive({ impurities: [impure(label)] }, { impurities: [impure(label), impure(price)] }, [
          both,
        ]),
      ),
    ).toEqual(["bench.p2.price purity is false @ bench/p2.ts#price | price calls console.info"]);
    // Only the subject whose anchor covers it.
    const onLabel: SubjectAnchors = {
      subject: OTHER,
      anchors: [{ path: FILE, symbol: "label", commit: BASE_COMMIT }],
    };
    expect(said(derive({}, { impurities: [impure(price)] }, [onPrice, onLabel]))).toEqual([
      "bench.p2.price purity is false @ bench/p2.ts#price | price calls console.info",
    ]);
  });

  it("[derive.purity-reach] a symbol reaches an impure step through resolved calls, deferred or not, and its effect rests on it and the symbol taking the step; a call the parser could not resolve reaches nothing", () => {
    const logs = impure(log);
    expect(
      said(
        derive(
          { impurities: [logs] },
          { impurities: [logs], calls: [{ from: price, to: log, deferred: false }] },
        ),
      ),
    ).toEqual([
      "bench.p2.price purity is false @ bench/log.ts#log,bench/p2.ts#price | price reaches console.info through log",
    ]);
    // Two hops, the second one deferred: when a step runs is not whether it does.
    const later = at(LOG, "later");
    expect(
      said(
        derive(
          {},
          {
            impurities: [impure(later, "setTimeout", "schedule")],
            calls: [
              { from: price, to: log, deferred: false },
              { from: log, to: later, deferred: true },
            ],
          },
        ),
      ),
    ).toEqual([
      // On the symbol covered and the one taking the step; not on the hops between.
      "bench.p2.price purity is false @ bench/log.ts#later,bench/p2.ts#price | price reaches setTimeout through later",
    ]);
    // No call from `price` in the facts: `log`'s step is not `price`'s.
    expect(said(derive({}, { impurities: [logs] }))).toEqual([]);
  });

  it("[derive.purity-property] a subject's purity is derived false exactly when a symbol its anchors cover reaches an impure step at head and reached none at base, whatever order the facts come in", () => {
    fc.assert(
      fc.property(treeArb, treeArb, subjectsArb, fc.nat(20), (base, head, anchorSets, by) => {
        const subjects = anchorSets.map((anchors, i) => ({
          subject: Schema.decodeUnknownSync(SubjectKey)(`s${String(i)}`),
          anchors,
        }));
        const before = reachingOf(base);
        const after = reachingOf(head);
        const gained = [
          ...head.calls.flatMap((c) => [c.from, c.to]),
          ...head.impurities.map((i) => i.in),
        ].filter((r) => after.has(keyOf(r)) && !before.has(keyOf(r)));
        const expected = subjects
          .filter((s) => gained.some((r) => s.anchors.some((a) => coveredBy(a, r))))
          .map((s) => s.subject)
          .toSorted();
        const derived = derive(base, head, subjects);
        const purity = derived.effects.filter((e) => e.proposition.predicate === "purity");
        expect(purity.map((e) => e.proposition.subject).toSorted()).toEqual(expected);
        for (const e of purity) {
          expect([e.proposition.relation, e.proposition.value]).toEqual(["is", false]);
          expect(e.anchors.every((a) => a.commit === HEAD_COMMIT)).toBe(true);
        }
        const reordered = derive(
          { calls: turned(base.calls, by), impurities: turned(base.impurities, by + 1) },
          { calls: turned(head.calls, by + 2), impurities: turned(head.impurities, by + 3) },
          turned(subjects, by),
        );
        expect(reordered).toEqual(derived);
      }),
    );
  });
});
