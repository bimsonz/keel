import { describe, expect, it } from "vitest";
import * as names from "../../../fixtures/forge-lite/src/domain/names.ts";
import * as permissions from "../../../fixtures/forge-lite/src/domain/permissions.ts";
import {
  BANK,
  PREMISE_BANK,
  brief,
  groupsFor,
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
    expect([count(tasks, "disjoint"), count(tasks, "shared"), count(tasks, "premise")]).toEqual([
      60, 30, 10,
    ]);
    expect(tasks.map((t) => t.index)).toEqual([...Array(100).keys()]);
  });

  it("[swarm.tasks-overlap] gives each disjoint task its own file and each group one shared file", () => {
    const tasks = planTasks({ seed: 42, count: 100, run: "r1" });
    const own = tasks.filter((t) => t.kind !== "shared").map((t) => t.path);
    expect(new Set(own).size).toBe(own.length);
    const byGroup = new Map<number | undefined, Task[]>();
    for (const s of tasks.filter((t) => t.kind === "shared"))
      byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
    expect(byGroup.size).toBe(5);
    for (const members of byGroup.values()) {
      expect(members).toHaveLength(6);
      expect(new Set(members.map((t) => t.path)).size).toBe(1);
    }
    const sharedPaths = [...byGroup.values()].map((m) => m[0]?.path);
    expect(new Set(sharedPaths).size).toBe(5);
    for (const path of sharedPaths) expect(own).not.toContain(path);
    const subjects = tasks.filter((t) => t.kind === "premise").map((t) => t.premises[0]?.subject);
    expect(new Set(subjects)).toEqual(new Set(["authz.permission-evaluation", "repo.visibility"]));
    for (const t of tasks) expect(t.path.startsWith("test/swarm/r1/")).toBe(true);
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
    const entries = [...BANK, ...PREMISE_BANK];
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

  it("[swarm.tasks-brief] tells a worker its file, its import, every case and what to declare", () => {
    const shared = planTasks({ seed: 1, count: 5, run: "r" }).find((t) => t.kind === "shared");
    if (shared === undefined) throw new Error("a run of 5 has a shared task");
    const text = brief(shared);
    expect(text).toContain(shared.path);
    expect(text).toContain(`from "../../../${shared.target.module}"`);
    expect(text).toContain("keep every line of it");
    for (const c of shared.cases)
      expect(text).toContain(
        `${shared.target.fn}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`,
      );
    expect(text).toContain(JSON.stringify([{ path: shared.path, op: "edit" }]));
  });
});
