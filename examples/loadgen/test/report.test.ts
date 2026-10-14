import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { score } from "../src/bench.ts";
import { compare, expectedTrunk } from "../src/integrity.ts";
import { planRun, type PairKey } from "../src/plan.ts";
import { percentile, summarise, ties, tieKey, type KeelEvent } from "../src/report.ts";

// Keel's own record of the smoke `lg5a` on keel.town (14 Oct): 5 agents, all landed;
// agents 1 and 2 are a planted premise pair, 3 and 4 share group 0's file.
const isEvents = (x: unknown): x is KeelEvent[] =>
  Array.isArray(x) &&
  x.every(
    (e) => typeof Reflect.get(Object(Reflect.get(Object(e), "payload")), "_tag") === "string",
  );
const read: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "lg5a-events.json"), "utf8"),
);
if (!isEvents(read)) throw new Error("the fixture is not a list of events");
const LG5A = read;
const AGENT = [
  "chg_01M4XKS2SDE8JSYPQAVCXC0FWK",
  "chg_01M4XKS5CXXQZZZS5RKQKZAJW2",
  "chg_01M4XKS2SKMJHR9G34A9PRZR00",
  "chg_01M4XKS2QCDKJ9K296HTDC9720",
  "chg_01M4XKS2Q6FP77MSRYAZGEQQF0",
];
const id = (i: number) => AGENT[i] ?? `chg_${i}`;

/** An event of one tag, with the fields a tie reads: enough to stand where Keel's would. */
function event(at: string, payload: Record<string, unknown>): KeelEvent {
  const list: unknown = [
    { eventId: `evt_${at}`, type: "x", entity: { kind: "change", id: "x" }, seq: 0, at, payload },
  ];
  if (!isEvents(list)) throw new Error("not an event");
  const [only] = list;
  if (only === undefined) throw new Error("not an event");
  return only;
}

const premisePairs = (n: number, planted: boolean, from: number): PairKey[] =>
  Array.from({ length: n }, (_, i) => ({
    pair: from + i,
    kind: "premise",
    planted,
    a: (from + i) * 2,
    b: (from + i) * 2 + 1,
  }));
const changeUnlessUnrun = (i: number) => (i === 31 ? undefined : `chg_${i}`);

describe("loadgen's reading of Keel's record", () => {
  it("[loadgen.ties-contradiction] ties a preflight contradiction to the change holding the proposition against it, and never ties neighbours alone", () => {
    const tied = ties(LG5A);
    expect(tied.has(tieKey(id(1), id(2)))).toBe(true);
    // Agents 3 and 4 are subject neighbours with the same premise: exposure, not a conflict.
    expect(tied.has(tieKey(id(3), id(4)))).toBe(false);
    expect(tied.size).toBe(1);
  });

  it("[loadgen.ties-counterparts] ties a change bounced on a textual conflict to each landed change its bounce names, and to no commit Keel did not land", () => {
    const tied = ties([
      event("2026-10-14T16:00:00Z", {
        _tag: "ChangeBounced",
        changeId: "chg_late",
        reasons: ["composition-refused: conflict src/p.ts"],
        counterparts: [
          { changeId: "chg_first", commitSha: "a".repeat(40), paths: ["src/p.ts"] },
          { commitSha: "b".repeat(40), paths: ["src/p.ts"] },
        ],
      }),
    ]);
    expect([...tied]).toEqual([tieKey("chg_first", "chg_late")]);
  });

  it("[loadgen.ties-conflicts] ties the parties of a suspected or noted conflict, a suspected premise's cause, and a bounce on a conflict", () => {
    const tied = ties([
      event("2026-10-14T16:00:00Z", {
        _tag: "ConflictSuspected",
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_a", "chg_b"],
      }),
      event("2026-10-14T16:00:01Z", {
        _tag: "ConflictNoted",
        conflictId: "cfl_2",
        changeId: "chg_c",
      }),
      event("2026-10-14T16:00:02Z", {
        _tag: "ChangeBounced",
        conflictId: "cfl_2",
        changeId: "chg_d",
        reasons: [],
      }),
      event("2026-10-14T16:00:03Z", {
        _tag: "PremiseSuspected",
        changeId: "chg_e",
        cause: { changeId: "chg_f" },
      }),
      event("2026-10-14T16:00:04Z", {
        _tag: "ChangeBounced",
        verdictId: "vrd_1",
        changeId: "chg_g",
        reasons: [],
      }),
    ]);
    expect([...tied].toSorted()).toEqual(
      [tieKey("chg_a", "chg_b"), tieKey("chg_c", "chg_d"), tieKey("chg_e", "chg_f")].toSorted(),
    );
  });

  it("[loadgen.report-numbers] counts the run's changes from Keel's record, overlap only on a subject", () => {
    const report = summarise(LG5A, new Set(AGENT), 5, [120, 80, 300, 90, 100]);
    expect({
      declared: report.declared,
      landed: report.landed,
      bounces: report.bounces,
      density: report.contentionDensity,
      promotions: report.trunk.promotions,
      perCommit: report.trunk.changesPerGroupCommit,
      preflight: report.preflightMs,
    }).toEqual({
      declared: 5,
      landed: 5,
      bounces: 0,
      density: 0.4,
      promotions: 5,
      perCommit: { mean: 1, max: 1 },
      preflight: { p50: 100, p99: 300 },
    });
    expect(report.queueMs.p50).toBeGreaterThan(0);
    expect(report.trunk.promotionMs.p50).toBeGreaterThan(0);
    // A change of another run's is not counted.
    expect(summarise(LG5A, new Set(AGENT.slice(0, 2)), 2, []).declared).toBe(2);
    expect([
      percentile([5, 1, 3, 2, 4], 50),
      percentile([5, 1, 3, 2, 4], 95),
      percentile([], 50),
    ]).toEqual([3, 5, null]);
  });

  it("[loadgen.bench-score] scores the key by kind against the ties, leaves out a pair Keel never saw, and holds 07's bars at their edge", () => {
    const key = [
      ...premisePairs(10, true, 0),
      ...premisePairs(5, false, 10),
      { pair: 15, kind: "effect" as const, planted: true, a: 30, b: 31 },
    ];
    // 7 of 10 planted tied; 1 of 5 decoys tied.
    const tied = new Set([
      ...[0, 1, 2, 3, 4, 5, 6].map((p) => tieKey(`chg_${p * 2}`, `chg_${p * 2 + 1}`)),
      tieKey("chg_20", "chg_21"),
    ]);
    const s = score(key, changeUnlessUnrun, tied);
    expect({
      premise: s.byKind.premise,
      unrun: s.unrun,
      recall: s.recall,
      fp: s.falsePositiveRate,
      passes: s.passes,
    }).toEqual({
      premise: { planted: 10, recalled: 7, decoys: 5, falsePositives: 1 },
      unrun: 1,
      recall: 0.7,
      fp: 0.2,
      passes: { recall: true, decoys: true },
    });
    tied.delete(tieKey("chg_12", "chg_13"));
    tied.add(tieKey("chg_22", "chg_23"));
    expect(score(key, changeUnlessUnrun, tied).passes).toEqual({ recall: false, decoys: false });
  });

  it("[loadgen.integrity] finds a lost write, a double landing and a file no landing made, applying landings in Keel's order", () => {
    const plan = planRun({ run: "r1", seed: 42, count: 50 });
    const group = plan.tasks.filter(
      (t) =>
        t.kind === "shared" &&
        t.edit.path === plan.tasks.find((u) => u.kind === "shared")?.edit.path,
    );
    const [first, second] = group;
    if (first === undefined || second === undefined) throw new Error("no shared group of two");
    const order = [first.index, second.index];
    const good = expectedTrunk(plan, order);
    expect(good.breaks).toEqual([]);
    expect(compare(good.files, new Map(good.files))).toEqual([]);

    // The second landing written over the first, as a lost update would leave it.
    const lost = new Map(good.files);
    lost.set(
      second.edit.path,
      expectedTrunk(plan, [second.index]).files.get(second.edit.path) ?? "",
    );
    expect(compare(good.files, lost)).toEqual([{ path: second.edit.path, why: "differs" }]);

    expect(expectedTrunk(plan, [...order, first.index]).breaks).toEqual([
      { path: first.edit.path, why: "landed-twice" },
    ]);
    const extra = new Map([...good.files, [`${plan.dir}/own/stray.ts`, ""]]);
    expect(compare(good.files, extra)).toEqual([
      { path: `${plan.dir}/own/stray.ts`, why: "unexpected" },
    ]);
  });
});
