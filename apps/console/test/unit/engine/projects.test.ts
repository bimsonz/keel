import { describe, expect, it } from "vitest";
import { Projects, projectOf } from "../../../src/engine/projects.ts";
import type { ConsoleSource } from "../../../src/engine/player.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { createRng } from "../../fixtures/prng.ts";
import { showing } from "../showing.ts";

const CONTROL = "prj_CONTROL";

/** A second project's events: created, made public, and trunk advanced once with verification switched off. */
function controlProject() {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(7));
  b.project = CONTROL;
  b.at(1).emit({
    type: "ProjectCreated",
    entity: { kind: "project", id: CONTROL },
    payload: { projectId: CONTROL, name: "control", by: "agt_op" },
  });
  b.emit({
    type: "TrunkInitialized",
    entity: { kind: "trunk", id: CONTROL },
    payload: { projectId: CONTROL, head: "a".repeat(40), by: "agt_op" },
  });
  b.emit({
    type: "TrunkAdvanced",
    entity: { kind: "trunk", id: CONTROL },
    payload: {
      projectId: CONTROL,
      from: "a".repeat(40),
      to: "b".repeat(40),
      groupId: "grp_1",
      landings: [],
      verified: false,
      height: 1,
    },
  });
  b.emit({
    type: "ProjectSettingsChanged",
    entity: { kind: "project", id: CONTROL },
    payload: {
      projectId: CONTROL,
      changes: [{ field: "visibility", from: "private", to: "public" }],
      by: "agt_op",
    },
  });
  return b.build().events;
}

/** Scenario 1's log with the second project's events in it, as an observer reads one Keel's log of every project. */
function twoProjects(): ConsoleSource {
  const one = createMockSource({ scenario: "s1", seed: 42 });
  const other = controlProject();
  return {
    ...one,
    async readEvents(request = {}) {
      const page = await one.readEvents(request);
      return request.cursor === undefined ? { ...page, items: [...other, ...page.items] } : page;
    },
  };
}

async function at(project: string | null) {
  const player = showing(twoProjects(), project ?? undefined);
  if (project === null) player.scopeTo(null);
  await player.load();
  player.seek(player.end);
  return player;
}

describe("one project among several in a log", () => {
  it("[projects.named] names every project the log has, with who may read each", async () => {
    const player = await at("demo");
    expect(player.projects.list).toEqual([
      { id: CONTROL, name: "control", visibility: "public", unverified: true },
      { id: player.world.project?.id, name: "demo", visibility: "private", unverified: false },
    ]);
  });

  it("[projects.scoped] folds a project from its own events and counts nothing of another's", async () => {
    const alone = showing(createMockSource({ scenario: "s1", seed: 42 }));
    await alone.load();
    alone.seek(alone.end);
    const demo = await at("demo");
    expect(demo.world.project?.name).toBe("demo");
    expect(demo.world.trunk).toEqual(alone.world.trunk);
    expect(demo.world.trunk.unverifiedAdvances).toBe(0);
    expect(demo.world.changes.size).toBe(alone.world.changes.size);

    const control = await at("control");
    expect(control.world.project).toEqual({ id: CONTROL, name: "control" });
    expect(control.world.trunk).toMatchObject({
      head: "b".repeat(40),
      advances: 1,
      unverifiedAdvances: 1,
    });
    expect(control.world.changes.size).toBe(0);
    expect(control.world.agents.size).toBe(0);
  });

  it("[projects.rescoped] folds again when another project is shown, and nothing at an address that names none", async () => {
    const player = await at("demo");
    const landed = player.world.trunk.changesLanded;
    expect(landed).toBeGreaterThan(0);
    player.scopeTo("control");
    expect(player.world.project?.name).toBe("control");
    expect(player.world.trunk.changesLanded).toBe(0);
    player.scopeTo(null);
    expect(player.world.project).toBeUndefined();
    expect(player.world.trunk.advances).toBe(0);
    player.scopeTo("no-such-project");
    expect(player.world.project).toBeUndefined();
    player.scopeTo("demo");
    expect(player.world.trunk.changesLanded).toBe(landed);
  });

  it("[player.unread] leaves out and counts an entry of Keel's log it cannot fold, and shows the rest", async () => {
    // An advance as Keel wrote one before it carried its landings: folding it reads a list that is not there.
    const advanced = controlProject().find((event) => event.type === "TrunkAdvanced");
    if (advanced === undefined) throw new Error("no advance");
    const { landings: _gone, ...old } = advanced.payload;
    const one = createMockSource({ scenario: "s1", seed: 42 });
    const withIt = (mode: "live" | "fixture"): ConsoleSource => ({
      ...one,
      descriptor: { ...one.descriptor, mode },
      async readEvents(request = {}) {
        const page = await one.readEvents(request);
        if (request.cursor !== undefined) return page;
        const project = page.items.find((event) => event.type === "ProjectCreated")?.project;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point of the test: an entry that is not the shape its type says
        const malformed = { ...advanced, project, payload: old } as unknown as typeof advanced;
        // Among the project's own events, after the first of them.
        return {
          ...page,
          items: [...page.items.slice(0, 3), malformed, ...page.items.slice(3)],
        };
      },
    });
    const alone = showing(createMockSource({ scenario: "s1", seed: 42 }));
    await alone.load();
    alone.seek(alone.end);

    const live = showing(withIt("live"));
    await live.load();
    live.seek(live.end);
    expect(live.unread).toBe(1);
    expect(live.world.changes.size).toBe(alone.world.changes.size);
    expect(live.world.trunk.changesLanded).toBe(alone.world.trunk.changesLanded);
    // Wound back and folded again, it is counted once, not twice.
    live.seek(0);
    live.seek(live.end);
    expect(live.unread).toBe(1);

    // A fixture's log is this console's own: a fault folding one is not passed over.
    const fixture = showing(withIt("fixture"));
    await fixture.load();
    expect(() => fixture.seek(fixture.end)).toThrow(TypeError);
  });

  it("[projects.of] takes an event's project from Keel's stamp, and failing that from what the event itself names", () => {
    const [created, , advanced] = controlProject();
    if (created === undefined || advanced === undefined) throw new Error("the log is short");
    expect(projectOf({ ...advanced, project: "prj_STAMPED" })).toBe("prj_STAMPED");
    const { project: _stamp, ...unstamped } = advanced;
    expect(projectOf(unstamped)).toBe(CONTROL);
    const projects = new Projects();
    expect(projects.note(created)).toBe(true);
    expect(projects.note(created)).toBe(false);
    expect(projects.named("control")?.id).toBe(CONTROL);
    expect(projects.named("demo")).toBeUndefined();
  });
});
