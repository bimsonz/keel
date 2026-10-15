import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { workerAt } from "../src/run/dispatch.ts";
import { Start } from "../src/run/start.ts";
import { brief, planTasks } from "../src/run/tasks.ts";

const TASKS = [
  {
    title: "Delete the dead per-run fold",
    brief: "Nothing reads `World.work` since the Agents tab went.\nDone when: grep finds nothing.",
  },
  {
    title: "Trunk's last update, on the Code tab",
    brief: "Source: `GET /v1/projects/{projectId}/trunk`, read nowhere today.",
  },
];
const START = { shape: "one", seed: 1, project: "prj_K" } as const;

describe("a run given its tasks", () => {
  it("[swarm.given-start] counts a run's workers from its tasks, and refuses a count that disagrees or a model that isn't a Workers AI id", () => {
    const started = v.parse(Start, { ...START, tasks: TASKS, model: "@cf/zai-org/glm-4.7-flash" });
    expect(started).toEqual({
      ...START,
      workers: 2,
      tasks: TASKS,
      model: "@cf/zai-org/glm-4.7-flash",
    });
    expect(v.parse(Start, { ...START, workers: 2, tasks: TASKS }).workers).toBe(2);
    expect(v.parse(Start, { ...START, workers: 5 })).toEqual({ ...START, workers: 5 });
    const refused = [
      { ...START, workers: 3, tasks: TASKS },
      { ...START },
      { ...START, tasks: [] },
      { ...START, tasks: [{ title: "", brief: "x" }] },
      { ...START, tasks: [{ title: "t", brief: "x", extra: true }] },
      { ...START, workers: 1, model: "gpt-4" },
    ];
    expect(refused.map((r) => v.safeParse(Start, r).success)).toEqual(refused.map(() => false));
  });

  it("[swarm.given-brief] starts each worker on its given task's brief, unchanged, with the run's model", () => {
    const run = { id: "r1", shape: "one", workers: 2, seed: 1, project: "prj_K" } as const;
    const given = { ...run, tasks: TASKS, model: "@cf/x/y" };
    expect([0, 1, 2].map((i) => workerAt(given, i, "one"))).toEqual([
      {
        id: "r1-0",
        initialData: { keyring: "one", run: "r1-0", project: "prj_K", model: "@cf/x/y" },
        message: TASKS[0]?.brief,
      },
      {
        id: "r1-1",
        initialData: { keyring: "one", run: "r1-1", project: "prj_K", model: "@cf/x/y" },
        message: TASKS[1]?.brief,
      },
      undefined,
    ]);
  });

  it("[swarm.given-label] runs each worker under its given task's label, and under the run's id and number where it has none", () => {
    const labelled = [
      { title: "a", brief: "a", label: "checksha-tests-004" },
      { title: "b", brief: "b" },
    ];
    const run = {
      id: "r1",
      shape: "one",
      workers: 2,
      seed: 1,
      project: "prj_K",
      tasks: labelled,
    } as const;
    expect([0, 1].map((i) => workerAt(run, i, "one")?.initialData.run)).toEqual([
      "checksha-tests-004",
      "r1-1",
    ]);
    expect(v.safeParse(Start, { ...START, tasks: labelled }).success).toBe(true);
    expect(
      v.safeParse(Start, { ...START, tasks: [{ title: "a", brief: "a", label: "Has Spaces" }] })
        .success,
    ).toBe(false);
  });

  it("[swarm.planned-brief] starts a run given no tasks on its planned ones, with the Worker's own model", () => {
    const run = { id: "r1", shape: "one", workers: 3, seed: 42, project: "prj_K" } as const;
    const planned = planTasks({ seed: 42, count: 3, run: "r1" })[1];
    if (planned === undefined) throw new Error("a run of three plans three tasks");
    expect(workerAt(run, 1, "one")).toEqual({
      id: "r1-1",
      initialData: { keyring: "one", run: "r1-1", project: "prj_K" },
      message: brief(planned),
    });
    // "many" accounts each work under the run's own label.
    expect(workerAt({ ...run, shape: "many" }, 1, "many-1")?.initialData).toEqual({
      keyring: "many-1",
      run: "r1",
      project: "prj_K",
    });
    expect(workerAt(run, 0, undefined)).toBeUndefined();
  });
});
