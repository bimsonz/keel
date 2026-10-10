import { describe, expect, it } from "vitest";
import { compare, type Proposition, SubjectKey, subjectsRelated } from "../../../src/domain/coordination/index.ts";
import { type ChangeId, CommitSha, Glob, makeId, matchesGlob } from "../../../src/domain/kernel/index.ts";
import {
  attribute,
  type BatchMember,
  batchSize,
  type CommutationInput,
  commutation,
  type Footprints,
  interpretLeaveOneOut,
  MAX_BATCH,
  planBatches,
  proofIdOf,
  type QueuedChange,
} from "../../../src/domain/integration/index.ts";
import { changeIdArb, changeIds, graphPropositionArb } from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

const id = (n: number) => makeId("chg", String(n).padStart(26, "0"));
const batchId = (n: number) => makeId("bat", String(n).padStart(26, "0"));

// ------------------------------------------------------------- commutation

const pathPool = ["src/authz/check.ts", "src/authz/cache.ts", "src/billing/charge.ts", "pnpm-lock.yaml", "docs/readme.md"] as const;
const affectedPool = ["test:authz", "test:billing", "guard:G-1", "test:docs"] as const;
const subjectPool = ["authz.permission-evaluation", "authz.audit-log", "billing.charge", "docs"] as const;

const footprintsArb: fc.Arbitrary<Footprints> = fc.record({
  changes: fc.subarray([...changeIds], { minLength: 1, maxLength: 2 }),
  paths: fc.subarray([...pathPool], { maxLength: 2 }),
  affected: fc.subarray([...affectedPool], { maxLength: 2 }),
  subjects: fc.subarray([...subjectPool], { maxLength: 2 }).map((s) => s.map((k) => SubjectKey.make(k))),
});

const barriers = [Glob.make("pnpm-lock.yaml"), Glob.make(".keel/policy/**")];
const head = CommitSha.make("d".repeat(40));
const base = CommitSha.make("e".repeat(40));

const commutationArb: fc.Arbitrary<CommutationInput> = fc.record({
  batch: fc.record({ id: fc.constant(batchId(1)), base: fc.constant(base), predecessors: fc.subarray([id(7), id(8)]), touched: footprintsArb }),
  intervening: footprintsArb,
  head: fc.constant(head),
  promoted: fc.subarray([id(7), id(8)]),
  mergeTreeClean: fc.boolean(),
  barriers: fc.constant(barriers),
  group: fc.array(fc.record({ id: fc.constantFrom(batchId(2), batchId(3)), touched: footprintsArb }), { maxLength: 2 }),
});

const disjoint = (n: number): Footprints => ({
  changes: [id(n)],
  paths: [`src/m${n}.ts`],
  affected: [`test:m${n}`],
  subjects: [SubjectKey.make(`m${n}`)],
});
const commuting: CommutationInput = {
  batch: { id: batchId(1), base, predecessors: [id(7)], touched: disjoint(1) },
  intervening: disjoint(2),
  head,
  promoted: [id(7)],
  mergeTreeClean: true,
  barriers,
  group: [{ id: batchId(2), touched: disjoint(3) }],
};

const shared = (f: Footprints, extra: Partial<Footprints>): Footprints => ({ ...f, ...extra });
const rev = (f: Footprints): Footprints => ({
  changes: f.changes.toReversed(),
  paths: f.paths.toReversed(),
  affected: f.affected.toReversed(),
  subjects: f.subjects.toReversed(),
});
const shareAny = (a: readonly string[], b: readonly string[]): boolean => a.some((x) => b.includes(x));
const linked = (a: Footprints, b: Footprints): boolean => a.subjects.some((x) => b.subjects.some((y) => subjectsRelated(x, y)));
const meets = (a: Footprints, b: Footprints): boolean => shareAny(a.paths, b.paths) || shareAny(a.affected, b.affected) || linked(a, b);

describe("commutation", () => {
  it("[commutation.sound] a batch commutes only when C1 to C6 all hold", () => {
    let commuted = 0;
    fc.assert(
      fc.property(commutationArb, (input) => {
        if (commutation(input)._tag !== "commutes") return true;
        commuted++;
        const b = input.batch.touched;
        const d = input.intervening;
        const members = [b, ...input.group.map((g) => g.touched)];
        return (
          input.batch.predecessors.every((p) => input.promoted.includes(p)) &&
          !shareAny(b.paths, d.paths) &&
          input.mergeTreeClean &&
          !shareAny(b.affected, d.affected) &&
          !linked(b, d) &&
          ![...b.paths, ...d.paths].some((p) => input.barriers.some((g) => matchesGlob(g, p))) &&
          members.every((x, i) => members.slice(i + 1).every((y) => !meets(x, y)))
        );
      }),
    );
    expect(commutation(commuting)._tag).toBe("commutes");
    expect(commuted).toBeGreaterThan(0);
  });

  it("[commutation.each-condition-blocks] breaking any one of C1 to C6 stops a commuting batch", () => {
    const broken: readonly (readonly [string, CommutationInput])[] = [
      ["C1", { ...commuting, promoted: [] }],
      ["C2 paths", { ...commuting, intervening: shared(commuting.intervening, { paths: ["src/m1.ts"] }) }],
      ["C2 merge", { ...commuting, mergeTreeClean: false }],
      ["C3", { ...commuting, intervening: shared(commuting.intervening, { affected: ["test:m1"] }) }],
      ["C4", { ...commuting, intervening: shared(commuting.intervening, { subjects: [SubjectKey.make("m1.cache")] }) }],
      ["C5", { ...commuting, intervening: shared(commuting.intervening, { paths: ["pnpm-lock.yaml"] }) }],
      ["C6", { ...commuting, group: [{ id: batchId(2), touched: shared(disjoint(3), { affected: ["test:m1"] }) }] }],
    ];
    expect(broken.map(([name, input]) => [name, commutation(input)._tag])).toEqual([
      ["C1", "wait"],
      ["C2 paths", "reverify"],
      ["C2 merge", "reverify"],
      ["C3", "reverify"],
      ["C4", "reverify"],
      ["C5", "reverify"],
      ["C6", "reverify"],
    ]);
    fc.assert(fc.property(commutationArb, (input) => input.mergeTreeClean || commutation(input)._tag !== "commutes"));
  });

  it("[commutation.reverify-scope-covers-the-meeting] a re-verification covers everything B and D share, and everything when a barrier or the merge failed", () => {
    fc.assert(
      fc.property(commutationArb, (input) => {
        const result = commutation(input);
        if (result._tag !== "reverify") return true;
        const b = input.batch.touched;
        const d = input.intervening;
        const barrier = [...b.paths, ...d.paths].some((p) => input.barriers.some((g) => matchesGlob(g, p)));
        if (barrier || !input.mergeTreeClean) return result.scope._tag === "all";
        if (result.scope._tag !== "where-they-meet") return false;
        const scope = result.scope;
        return (
          b.affected.filter((x) => d.affected.includes(x)).every((x) => scope.affected.includes(x)) &&
          b.subjects.filter((x) => d.subjects.some((y) => subjectsRelated(x, y))).every((x) => scope.subjects.includes(x))
        );
      }),
    );
    const c4 = commutation({ ...commuting, intervening: { ...commuting.intervening, subjects: [SubjectKey.make("m1")] } });
    expect(c4._tag === "reverify" ? c4.scope : undefined).toEqual({ _tag: "where-they-meet", affected: [], subjects: ["m1"] });
  });

  it("[commutation.wait-for-predecessors] a batch whose predecessors are not all promoted waits, whatever else holds", () => {
    fc.assert(
      fc.property(commutationArb, (input) => {
        const missing = input.batch.predecessors.filter((p) => !input.promoted.includes(p));
        const result = commutation(input);
        return missing.length === 0 ? result._tag !== "wait" : result._tag === "wait" && result.unpromoted.length === missing.length;
      }),
    );
    expect(commutation({ ...commuting, promoted: [] })).toEqual({ _tag: "wait", unpromoted: [id(7)] });
  });

  it("[commutation.proof-id-deterministic] Proof-Id is a function of the C1 to C6 inputs alone, whatever their order", () => {
    fc.assert(
      fc.property(commutationArb, (input) => {
        const shuffled: CommutationInput = {
          ...input,
          batch: { ...input.batch, predecessors: input.batch.predecessors.toReversed(), touched: rev(input.batch.touched) },
          intervening: rev(input.intervening),
          promoted: input.promoted.toReversed(),
          group: input.group.toReversed().map((g) => ({ ...g, touched: rev(g.touched) })),
        };
        expect(proofIdOf(shuffled)).toBe(proofIdOf(input));
        expect(proofIdOf({ ...input, head: CommitSha.make("f".repeat(40)) })).not.toBe(proofIdOf(input));
        expect(proofIdOf({ ...input, intervening: { ...input.intervening, affected: [...input.intervening.affected, "test:new"] } })).not.toBe(
          proofIdOf(input),
        );
      }),
    );
    const proved = commutation(commuting);
    expect(proved._tag === "commutes" ? proved.proofId : undefined).toBe(proofIdOf(commuting));
  });
});

// ---------------------------------------------------------------- batching

const queueArb: fc.Arbitrary<readonly QueuedChange[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 10 })
  .chain((ns) =>
    fc.tuple(
      ...ns.map((n) =>
        fc.record({
          id: fc.constant(id(n)),
          effects: fc.array(graphPropositionArb, { maxLength: 2 }),
          risky: fc.boolean().map((r) => r && n % 3 === 0),
        }),
      ),
    ),
  );

const pairsArb = (queue: readonly QueuedChange[]) =>
  fc.array(fc.tuple(fc.constantFrom(...queue.map((q) => q.id)), fc.constantFrom(...queue.map((q) => q.id))), { maxLength: 4 });

const batchingArb = queueArb.chain((queue) =>
  fc.record({
    queue: fc.constant(queue),
    p: fc.constantFrom(0, 0.01, 0.05, 0.2, 0.5),
    suspected: queue.length === 0 ? fc.constant<readonly (readonly [ChangeId, ChangeId])[]>([]) : pairsArb(queue),
  }),
);

const contradicts = (a: Proposition, b: Proposition): boolean =>
  compare(a, b).outcome === "contradicts" || compare(b, a).outcome === "contradicts";
const opposed = (a: QueuedChange, b: QueuedChange): boolean => a.effects.some((x) => b.effects.some((y) => contradicts(x, y)));

describe("belief-aware batching", () => {
  it("[batching.size-formula] N = clamp(ln 0.8 / ln(1 − p), 1, 16), so a batch of N passes with probability at least 0.8", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (p, q) => {
        const n = batchSize(p);
        const ok = Number.isInteger(n) && n >= 1 && n <= MAX_BATCH;
        const monotone = p > q || batchSize(p) >= batchSize(q);
        const reliable = n === 1 || p === 0 || (1 - p) ** n >= 0.8 - 1e-12;
        return ok && monotone && reliable;
      }),
    );
    expect([batchSize(0), batchSize(5e-324), batchSize(0.01), batchSize(0.2), batchSize(1), batchSize(Number.NaN)]).toEqual([16, 16, 16, 1, 1, 1]);
  });

  it("[batching.no-suspected-pair] a batch never holds two changes with an open suspected conflict", () => {
    let constrained = 0;
    fc.assert(
      fc.property(batchingArb, ({ queue, p, suspected }) => {
        if (suspected.length > 0) constrained++;
        return planBatches(queue, p, suspected).every((batch) =>
          suspected.every(([a, b]) => a === b || !(batch.includes(a) && batch.includes(b))),
        );
      }),
    );
    expect(constrained).toBeGreaterThan(0);
    const q: QueuedChange[] = [1, 2].map((n) => ({ id: id(n), effects: [], risky: false }));
    expect(planBatches(q, 0, [[id(1), id(2)]])).toEqual([[id(1)], [id(2)]]);
  });

  it("[batching.no-opposite-effects] a batch never holds two changes with opposite effects on one subject", () => {
    fc.assert(
      fc.property(batchingArb, ({ queue, p, suspected }) => {
        const byId = new Map(queue.map((q) => [q.id, q]));
        return planBatches(queue, p, suspected).every((batch) =>
          batch.every((a, i) => batch.slice(i + 1).every((b) => !opposed(byId.get(a)!, byId.get(b)!))),
        );
      }),
    );
    const subject = SubjectKey.make("authz.permission-evaluation");
    const fresher: QueuedChange = { id: id(1), effects: [{ subject, predicate: "freshness", relation: "is", value: "per-call" }], risky: false };
    const staler: QueuedChange = { id: id(2), effects: [{ subject, predicate: "freshness", relation: "is", value: "per-session" }], risky: false };
    expect(planBatches([fresher, staler], 0, [])).toEqual([[id(1)], [id(2)]]);
  });

  it("[batching.risky-alone] a risky change is always batched alone", () => {
    fc.assert(
      fc.property(batchingArb, ({ queue, p, suspected }) => {
        const risky = new Set(queue.filter((q) => q.risky).map((q) => q.id));
        return planBatches(queue, p, suspected).every((batch) => batch.length === 1 || batch.every((c) => !risky.has(c)));
      }),
    );
    const q: QueuedChange[] = [
      { id: id(3), effects: [], risky: true },
      { id: id(4), effects: [], risky: false },
    ];
    expect(planBatches(q, 0, [])).toEqual([[id(3)], [id(4)]]);
  });

  it("[batching.bounded] batches hold at most N, at most four deep, each change once, and only queued changes", () => {
    fc.assert(
      fc.property(batchingArb, ({ queue, p, suspected }) => {
        const batches = planBatches(queue, p, suspected);
        const placed = batches.flat();
        return (
          batches.length <= 4 &&
          batches.every((b) => b.length >= 1 && b.length <= batchSize(p)) &&
          new Set(placed).size === placed.length &&
          placed.every((c) => queue.some((q) => q.id === c))
        );
      }),
    );
    const q = Array.from({ length: 40 }, (_, i): QueuedChange => ({ id: id(i + 1), effects: [], risky: false }));
    expect(planBatches(q, 0.2, []).length).toBe(4);
  });

  it("[batching.head-first-and-greedy] the queue's head rides in the first batch, and a waiting change fits nowhere", () => {
    fc.assert(
      fc.property(batchingArb, ({ queue, p, suspected }) => {
        const batches = planBatches(queue, p, suspected);
        const byId = new Map(queue.map((q) => [q.id, q]));
        const [first] = queue;
        const headOk = first === undefined ? batches.length === 0 : (batches[0] ?? []).includes(first.id);
        const waiting = queue.filter((q) => !batches.flat().includes(q.id));
        const fitsSomewhere = (c: QueuedChange): boolean =>
          batches.length < 4 ||
          batches.some(
            (b) =>
              !c.risky &&
              b.length < batchSize(p) &&
              b.every((m) => !byId.get(m)!.risky && !opposed(byId.get(m)!, c) && !suspected.some(([x, y]) => (x === m && y === c.id) || (x === c.id && y === m))),
          );
        return headOk && waiting.every((c) => !fitsSomewhere(c));
      }),
    );
    const q = [1, 2, 3].map((n): QueuedChange => ({ id: id(n), effects: [], risky: false }));
    expect(planBatches(q, 0, [])).toEqual([[id(1), id(2), id(3)]]);
  });
});

// ------------------------------------------------------------- attribution

const memberArb: fc.Arbitrary<readonly BatchMember[]> = fc
  .subarray([1, 2, 3, 4, 5], { minLength: 1 })
  .chain((ns) => fc.tuple(...ns.map((n) => fc.record({ id: fc.constant(id(n)), affected: fc.subarray([...affectedPool]) }))));

describe("attribution", () => {
  it("[attribution.suspects-touch-the-check] the suspects are exactly the members whose Affected set holds the failing check", () => {
    fc.assert(
      fc.property(memberArb, fc.constantFrom(...affectedPool), (members, check) => {
        const touching = members.filter((m) => m.affected.includes(check)).map((m) => m.id);
        const { suspects, graphGap } = attribute(check, members);
        return touching.length === 0 || (!graphGap && JSON.stringify(suspects) === JSON.stringify(touching));
      }),
    );
    const members: BatchMember[] = [
      { id: id(1), affected: ["test:authz"] },
      { id: id(2), affected: ["test:billing"] },
    ];
    expect(attribute("test:billing", members).next).toEqual({ _tag: "culprit", id: id(2) });
  });

  it("[attribution.graph-gap-suspects-all] when no member's Affected set holds the check, every member is a suspect and the gap is reported", () => {
    fc.assert(
      fc.property(memberArb, (members) => {
        const { suspects, graphGap } = attribute("test:unmapped", members);
        return graphGap && suspects.length === members.length;
      }),
    );
    expect(attribute("test:unmapped", [{ id: id(1), affected: [] }, { id: id(2), affected: [] }]).suspects).toEqual([id(1), id(2)]);
  });

  it("[attribution.leave-one-out-trials] several suspects get one trial each, leaving out exactly that suspect", () => {
    fc.assert(
      fc.property(memberArb, fc.constantFrom(...affectedPool), (members, check) => {
        const { suspects, next } = attribute(check, members);
        if (suspects.length < 2) return next._tag === "culprit" && next.id === suspects[0];
        return (
          next._tag === "leave-one-out" &&
          next.trials.length === suspects.length &&
          next.trials.every((t, i) => t.without === suspects[i] && t.members.length === members.length - 1 && !t.members.includes(t.without))
        );
      }),
    );
    const both: BatchMember[] = [{ id: id(1), affected: ["test:authz"] }, { id: id(2), affected: ["test:authz"] }];
    expect(attribute("test:authz", both).next).toEqual({
      _tag: "leave-one-out",
      trials: [{ without: id(1), members: [id(2)] }, { without: id(2), members: [id(1)] }],
    });
  });

  it("[attribution.reads-leave-one-out] one fixing removal names the culprit; every removal fixing it is an interaction; none is inconclusive", () => {
    fc.assert(
      fc.property(fc.uniqueArray(changeIdArb, { minLength: 2, maxLength: 4 }), fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), (ids, passes) => {
        const results = ids.map((without, i) => ({ without, passed: passes[i] ?? false }));
        const fixes = results.filter((r) => r.passed);
        const finding = interpretLeaveOneOut(results);
        if (fixes.length === results.length) return finding._tag === "interaction" && finding.parties.length === ids.length;
        if (fixes.length === 1) return finding._tag === "culprit" && finding.id === fixes[0]?.without;
        return finding._tag === "inconclusive";
      }),
    );
    expect(interpretLeaveOneOut([{ without: id(1), passed: true }, { without: id(2), passed: true }])._tag).toBe("interaction");
  });
});

