import { describe, expect, it } from "vitest";
import * as names from "../../../fixtures/forge-lite/src/domain/names.ts";
import * as permissions from "../../../fixtures/forge-lite/src/domain/permissions.ts";
import {
  BANK,
  PREMISE_BANK,
  brief,
  groupsFor,
  keyOf,
  mix,
  planTasks,
  type Task,
} from "../src/run/tasks.ts";

const count = (tasks: readonly Task[], kind: Task["kind"]) =>
  tasks.filter((t) => t.kind === kind).length;

describe("a run's tasks", () => {
  it("[swarm.tasks-mix] splits 60/30/10, in groups of two or more", () => {
    expect(mix(100)).toEqual({ disjoint: 60, shared: 30, premise: 10 });
    expect(mix(20)).toEqual({ disjoint: 12, shared: 6, premise: 2 });
    expect(mix(5)).toEqual({ disjoint: 3, shared: 2, premise: 0 });
    expect([groupsFor(30), groupsFor(6), groupsFor(2), groupsFor(1)]).toEqual([5, 3, 1, 0]);
    const tasks = planTasks({ seed: 42, count: 100, run: "r1" });
    // The pairs come first; the rest split as any run does.
    expect(count(tasks, "pair")).toBe(18);
    expect([count(tasks, "disjoint"), count(tasks, "shared"), count(tasks, "premise")]).toEqual([
      49, 25, 8,
    ]);
    expect(tasks.map((t) => t.index)).toEqual([...Array(100).keys()]);
  });

  it("[swarm.tasks-overlap] gives each disjoint task its own file and each group one shared file", () => {
    const tasks = planTasks({ seed: 42, count: 100, run: "r1" });
    const own = tasks
      .filter((t) => t.kind !== "shared" && t.change === undefined)
      .map((t) => t.path);
    expect(new Set(own).size).toBe(own.length);
    const byGroup = new Map<number | undefined, Task[]>();
    for (const s of tasks.filter((t) => t.kind === "shared"))
      byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
    expect(byGroup.size).toBe(5);
    for (const members of byGroup.values()) {
      expect(members).toHaveLength(5);
      expect(new Set(members.map((t) => t.path)).size).toBe(1);
    }
    const sharedPaths = [...byGroup.values()].map((m) => m[0]?.path);
    expect(new Set(sharedPaths).size).toBe(5);
    for (const path of sharedPaths) expect(own).not.toContain(path);
    const subjects = tasks.filter((t) => t.kind === "premise").map((t) => t.premises[0]?.subject);
    expect(new Set(subjects)).toEqual(new Set(["authz.permission-evaluation", "repo.visibility"]));
    for (const t of tasks.filter((task) => task.change === undefined))
      expect(t.path.startsWith("test/swarm/r1/")).toBe(true);
  });

  it("[swarm.tasks-seeded] plans the same run from the same seed, and another from another", () => {
    const a = planTasks({ seed: 7, count: 20, run: "r" });
    expect(planTasks({ seed: 7, count: 20, run: "r" })).toEqual(a);
    expect(planTasks({ seed: 8, count: 20, run: "r" })).not.toEqual(a);
  });

  it("[swarm.tasks-truth] asks for the answers the fixture's own functions give", () => {
    const fns = new Map(
      Object.entries({ ...names, ...permissions }).filter(([, f]) => typeof f === "function"),
    );
    const paired = planTasks({ seed: 1, count: 60, run: "r" }).filter((t) => t.kind === "pair");
    for (const t of paired) expect(fns.get(t.target.fn)).toBeTypeOf("function");
    const entries = [...BANK, ...PREMISE_BANK, ...paired.filter((t) => t.change === undefined)];
    expect(entries.length).toBeGreaterThan(0);
    for (const { target, cases } of entries) {
      const fn = fns.get(target.fn);
      if (typeof fn !== "function") throw new Error(`the fixture has no function ${target.fn}`);
      for (const c of cases) {
        const answer: unknown = Reflect.apply(fn, undefined, c.args);
        const accepted = target.answers === "validator" ? answer === undefined : answer;
        expect({ call: `${target.fn}(${JSON.stringify(c.args)})`, accepted }).toEqual({
          call: `${target.fn}(${JSON.stringify(c.args)})`,
          accepted: c.expected,
        });
      }
    }
  });

  it("[swarm.tasks-brief] tells a worker its file, its import, every case and what it relies on, and nothing of how Keel works", () => {
    const tasks = planTasks({ seed: 1, count: 10, run: "r" });
    const shared = tasks.find((t) => t.kind === "shared");
    const premised = tasks.find((t) => t.kind === "premise");
    if (shared === undefined || premised === undefined)
      throw new Error("a run of 10 has a shared task and a premise task");
    const text = brief(shared);
    expect(text).toContain(shared.path);
    expect(text).toContain(`from "../../../${shared.target.module}"`);
    expect(text).toContain("keep every line of it");
    for (const c of shared.cases)
      expect(text).toContain(
        `${shared.target.fn}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`,
      );
    for (const p of premised.premises) expect(brief(premised)).toContain(JSON.stringify(p));
    for (const said of [text, brief(premised)])
      expect(said).not.toMatch(/declare|footprint|workspace|lease|submit|rebase/i);
  });
});

const sides = (tasks: readonly Task[], kind: string, planted: boolean) => {
  const a = tasks.find(
    (t) => t.pair?.kind === kind && t.pair.planted === planted && t.pair.side === "a",
  );
  const b = tasks.find(
    (t) => t.pair?.kind === kind && t.pair.planted === planted && t.pair.side === "b",
  );
  if (a === undefined || b === undefined) throw new Error(`no ${kind} pair, planted ${planted}`);
  return [a, b] as const;
};
const purityOf = (task: Task) =>
  task.premises.map((p) => ({
    subject: p.subject,
    predicate: p.predicate,
    value: p.value,
    anchors: p.anchors,
  }));

describe("a run's planted pairs", () => {
  const BASE = "a".repeat(40);
  const plan = (workers: number) => planTasks({ seed: 7, count: workers, run: "r9", base: BASE });
  it("[swarm.pairs-key] plants each kind's pair and its decoy from twelve workers, keyed by worker index, and none below", () => {
    expect(count(plan(11), "pair")).toBe(0);
    const tasks = plan(20);
    expect(tasks).toHaveLength(20);
    expect(tasks.map((t) => t.index)).toEqual([...Array(20).keys()]);
    const key = keyOf(tasks);
    expect(key.map(({ kind, planted }) => `${kind} ${planted}`)).toEqual([
      "effect true",
      "effect false",
      "premise true",
      "premise false",
      "textual true",
      "textual false",
    ]);
    for (const k of key) {
      expect(tasks[k.a]?.pair).toMatchObject({ pair: k.pair, side: "a" });
      expect(tasks[k.b]?.pair).toMatchObject({ pair: k.pair, side: "b" });
    }
    expect(keyOf(plan(60)).filter((k) => k.planted)).toHaveLength(6);
  });

  it("[swarm.pairs-conflict] makes a planted pair conflict and its decoy not, in the way its kind names", () => {
    const tasks = plan(20);
    const [effectA, effectB] = sides(tasks, "effect", true);
    expect(effectA.change).toContain("console.info");
    expect(effectA.path).toBe(effectB.target.module);
    expect(purityOf(effectB)).toEqual([
      {
        subject: "swarm.r9.checkColor",
        predicate: "purity",
        value: true,
        anchors: [{ path: "src/domain/names.ts", symbol: "checkColor", commit: BASE }],
      },
    ]);
    const [decoyA, decoyB] = sides(tasks, "effect", false);
    expect(decoyA.change).not.toContain("console");
    expect(decoyA.target.fn).toBe(decoyB.target.fn);
    const [premiseA, premiseB] = sides(tasks, "premise", true);
    expect(purityOf(premiseA).map((p) => p.value)).toEqual([true]);
    expect(purityOf(premiseB).map((p) => p.value)).toEqual([false]);
    expect(premiseA.premises[0]?.subject).toBe(premiseB.premises[0]?.subject);
    const [agreeA, agreeB] = sides(tasks, "premise", false);
    expect([...purityOf(agreeA), ...purityOf(agreeB)].map((p) => p.value)).toEqual([true, true]);
    const [textA, textB] = sides(tasks, "textual", true);
    expect([textA.target.fn, textB.target.fn]).toEqual(["checkBranch", "checkBranch"]);
    expect(textA.change).not.toBe(textB.change);
    const [apartA, apartB] = sides(tasks, "textual", false);
    expect(apartA.path).toBe(apartB.path);
    expect(apartA.target.fn).not.toBe(apartB.target.fn);
  });

  it("[swarm.pairs-brief] tells a pair's changing side its file and change, and nothing of how Keel works", () => {
    const [effectA] = sides(plan(20), "effect", true);
    const text = brief(effectA);
    expect(text).toContain("File: src/domain/names.ts.");
    expect(text).toContain('console.info("checkColor"');
    expect(text).toContain("Keep every message and every answer exactly as they are.");
    expect(text).not.toMatch(/declare|footprint|workspace|lease|submit|rebase|premise/i);
  });
});
