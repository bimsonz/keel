import { describe, expect, it } from "vitest";
import type { ChangeState } from "../../../src/domain/state.ts";
import { createRng } from "../../fixtures/prng.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import {
  FILTERS_OF_CHANGE,
  changeNamed,
  changesOf,
  conflictNamed,
  conflictsOf,
  escalationNamed,
  escalationsOf,
  filtersOfChange,
  openCounts,
  waitsOnARuling,
} from "../../../src/engine/lists.ts";
import { World } from "../../../src/engine/world.ts";
import { showing } from "../showing.ts";

async function worldAt(scenario: "s1" | "s2", seconds: number, ruling?: string): Promise<World> {
  const player = showing(
    createMockSource({ scenario, seed: 42, ...(ruling === undefined ? {} : { ruling }) }),
  );
  await player.load();
  player.seek(seconds * 1000);
  return player.world;
}

/** One change declared for each id, a second apart, each with the label Keel gave it, if it gave one. */
function worldOf(changes: { id: string; label?: string }[]): World {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(3));
  b.at(0).emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: "agt_1" },
    payload: {
      agentId: "agt_1",
      projectId: "prj_1",
      name: "agent",
      kind: "hosted",
      scopes: ["agent:work"],
    },
  });
  changes.forEach((change, index) => {
    b.at(index + 1).emit({
      type: "IntentDeclared",
      entity: { kind: "change", id: change.id },
      ...(change.label === undefined ? {} : { label: change.label }),
      payload: {
        changeId: change.id,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal: `goal ${index + 1}`,
        footprint: [],
        premises: [],
        leaseId: "l",
      },
    });
  });
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

describe("the list of changes", () => {
  it("[lists.proposals] an open proposal is filed under Proposals as well as Open; waiting for approval, it waits on no ruling; landed or closed, it is no open proposal", () => {
    const proposal = {
      fork: "prj_01J9FFFFFFFFFFFFFFFFFFFFFF",
      commit: "c".repeat(40),
      proposer: "user:usr_1",
    };
    const waiting = {
      state: "parked" as const,
      parkedOn: "awaiting-approval" as const,
      parkedFrom: "queued" as const,
      proposal,
    };
    expect(filtersOfChange(waiting)).toEqual(["open", "proposals"]);
    expect(waitsOnARuling(waiting)).toBe(false);
    expect(filtersOfChange({ state: "queued", proposal })).toEqual(["open", "proposals"]);
    expect(filtersOfChange({ state: "landed", proposal })).toEqual(["closed", "landed"]);
    expect(filtersOfChange({ state: "withdrawn", proposal })).toEqual(["closed"]);
    expect(filtersOfChange({ state: "queued" })).toEqual(["open"]);
  });

  it("[lists.filed] files each change as open or closed, and under its narrower filter, newest first, with what it is tied to", async () => {
    const held = await worldAt("s1", 472, "live");
    const parked = changesOf(held, "parked");
    expect(parked.counts).toEqual({
      open: 2,
      closed: 0,
      landed: 0,
      parked: 2,
      bounced: 0,
      // The story's changes are its agents': none is a proposal from a fork.
      proposals: 0,
    });
    expect(parked.rows.map((row) => row.label)).toEqual(["#2", "#1"]);
    expect(parked.rows[1]).toMatchObject({
      name: "1",
      goal: "Speed up permission checks",
      state: "parked",
      agentClass: "real",
      subject: "authz.permission-evaluation",
      conflicts: [{ label: "C-1", name: "C-1" }],
      escalation: { label: "E-1", name: "E-1", open: true },
    });
    expect(changesOf(held, "landed").rows).toEqual([]);

    const done = await worldAt("s1", 9999);
    expect(changesOf(done, "landed").counts).toEqual({
      open: 0,
      closed: 2,
      landed: 2,
      parked: 0,
      bounced: 0,
      proposals: 0,
    });
    expect(changesOf(done, "closed").rows.map((row) => row.label)).toEqual(["#2", "#1"]);
    expect(changesOf(done, "landed").rows[0]?.escalation).toMatchObject({
      label: "E-1",
      open: false,
    });
    // By Keel's numbers, newest first, each with who declared it.
    expect(
      changesOf(done, "landed").rows.map((row) => [
        row.label,
        row.state,
        row.agent,
        row.agentClass,
      ]),
    ).toEqual([
      ["#2", "landed", "Agent A", "real"],
      ["#1", "landed", "Agent B", "real"],
    ]);
  });

  it("[lists.open-or-closed] files every state of a change as open or closed, never both, so the two count every change once", async () => {
    const states: ChangeState[] = [
      "declared",
      "working",
      "submitted",
      "deriving",
      "drifted",
      "verifying",
      "queued",
      "integrating",
      "landed",
      "bounced",
      "parked",
      "withdrawn",
      "superseded",
    ];
    expect(Object.keys(FILTERS_OF_CHANGE).toSorted()).toEqual(states.toSorted());
    for (const state of states)
      expect(
        FILTERS_OF_CHANGE[state].filter((filter) => filter === "open" || filter === "closed"),
      ).toHaveLength(1);
    // Scenario 2 has a change that bounced beside the ones that landed. Bounced is not the end of it: its agent
    // may revise it. So it is open, and filed as bounced too.
    const world = await worldAt("s2", 200);
    const { counts, rows } = changesOf(world, "bounced");
    expect(rows.map((row) => [row.label, row.state])).toEqual([["#1205", "bounced"]]);
    expect(changesOf(world, "open").rows.map((row) => row.label)).toContain("#1205");
    expect(changesOf(world, "closed").rows.map((row) => row.label)).not.toContain("#1205");
    expect(counts.open + counts.closed).toBe(world.changes.size);
  });

  it("shows a page at a time, and says when there is more", () => {
    const world = worldOf(
      Array.from({ length: 120 }, (_, index) => ({
        id: `chg_${index + 1}`,
        label: `#${index + 1}`,
      })),
    );
    const first = changesOf(world, "open");
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]?.label).toBe("#120");
    expect(first).toMatchObject({ total: 120, more: true });
    const all = changesOf(world, "open", 150);
    expect(all.rows).toHaveLength(120);
    expect(all.more).toBe(false);
  });
});

describe("the list of conflicts", () => {
  it("lists an open conflict with its sides, its probe and its question, and a settled one with what it left", async () => {
    const held = await worldAt("s1", 472, "live");
    const open = conflictsOf(held, "open");
    expect(open.counts).toEqual({ open: 1, settled: 0 });
    expect(open.rows[0]).toMatchObject({
      label: "C-1",
      name: "C-1",
      state: "escalated",
      kind: "semantic",
      subject: "authz.permission-evaluation",
      probe: { label: "P-1" },
      escalation: { label: "E-1", open: true },
    });
    expect(open.rows[0]?.parties.map((party) => party.label).toSorted()).toEqual(["#1", "#2"]);
    expect(open.rows[0]?.summary).not.toBe("");

    const done = await worldAt("s1", 9999);
    const settled = conflictsOf(done, "settled");
    expect(settled.counts).toEqual({ open: 0, settled: 1 });
    expect(settled.rows[0]).toMatchObject({
      label: "C-1",
      state: "resolved",
      guard: { label: "G-1" },
      decision: { id: expect.any(String), label: "D-1" },
    });
  });
});

describe("the list of escalations", () => {
  it("lists an open question with what waits on it, and an answered one with what was ruled", async () => {
    const held = await worldAt("s1", 472, "live");
    const open = escalationsOf(held, "open");
    expect(open.counts).toEqual({ open: 1, closed: 0 });
    expect(open.rows[0]).toMatchObject({
      label: "E-1",
      name: "E-1",
      question: "May permission checks be cached within a session?",
      state: "open",
      category: "permission-semantics",
      subject: "authz.permission-evaluation",
      conflict: { label: "C-1" },
      parked: 2,
    });

    const done = await worldAt("s1", 9999);
    const closed = escalationsOf(done, "closed");
    expect(closed.counts).toEqual({ open: 0, closed: 1 });
    expect(closed.rows[0]).toMatchObject({
      state: "ruled",
      ruled: "Cache allowed if revocation invalidates it",
      decision: { id: expect.any(String), label: "D-1" },
      parked: 0,
    });
  });
});

describe("what the tabs count", () => {
  it("is what is still open: changes not yet landed, conflicts not settled, questions not answered", async () => {
    expect(openCounts(await worldAt("s1", 472, "live"))).toEqual({
      changes: 2,
      conflicts: 1,
      escalations: 1,
    });
    expect(openCounts(await worldAt("s1", 9999))).toEqual({
      changes: 0,
      conflicts: 0,
      escalations: 0,
    });
  });

  it("[lists.open-count] counts a bounced change as open, and the tab counts what the Open filter lists", async () => {
    const world = await worldAt("s2", 200);
    const { counts } = changesOf(world, "open");
    expect(counts.bounced).toBe(1);
    expect(openCounts(world).changes).toBe(counts.open);
  });
});

describe("finding a thing by what an address calls it", () => {
  it("finds a change by its number or its id, and a conflict and a question by their labels", async () => {
    const world = await worldAt("s1", 472, "live");
    const one = changeNamed(world, "1");
    expect(one?.label).toBe("#1");
    expect(changeNamed(world, one?.id ?? "")).toBe(one);
    expect(changesOf(world, "parked").rows.find((row) => row.id === one?.id)?.name).toBe("1");
    const conflict = conflictNamed(world, "C-1");
    expect(conflict?.label).toBe("C-1");
    expect(conflictsOf(world, "open").rows[0]?.name).toBe("C-1");
    expect(escalationNamed(world, "E-1")?.question).toBe(
      "May permission checks be cached within a session?",
    );
    expect(changeNamed(world, "999")).toBeUndefined();
  });

  it("calls a change by its id where another shares its label, and finds neither by that label", () => {
    // Keel gave no label, so each is shown by the end of its id, and the two ends are the same.
    const world = worldOf([
      { id: "chg_a_ab12" },
      { id: "chg_b_ab12" },
      { id: "chg_c", label: "#7" },
    ]);
    expect([...world.changes.values()].map((change) => change.label)).toEqual([
      "ab12",
      "ab12",
      "#7",
    ]);
    expect(changeNamed(world, "ab12")).toBeUndefined();
    expect(changeNamed(world, "chg_a_ab12")?.id).toBe("chg_a_ab12");
    expect(changesOf(world, "open").rows.map((row) => row.name)).toEqual([
      "7",
      "chg_b_ab12",
      "chg_a_ab12",
    ]);
    // Alone, that same end of an id is a name, and finds its change.
    expect(
      changeNamed(worldOf([{ id: "chg_a_ab12" }, { id: "chg_c", label: "#7" }]), "ab12")?.id,
    ).toBe("chg_a_ab12");
  });

  it("gives every thing a name that finds that thing again, whatever label Keel gave it or did not", () => {
    // No label; a label of Keel's; a label that is another's id; and a label that reads as another's number.
    const world = worldOf([
      { id: "chg_x_ab12" },
      { id: "chg_c", label: "#7" },
      { id: "chg_d", label: "#chg_c" },
      { id: "chg_e_0007" },
      { id: "7" },
    ]);
    const rows = changesOf(world, "open").rows;
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => changeNamed(world, row.name)?.id)).toEqual(rows.map((row) => row.id));
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
  });
});
