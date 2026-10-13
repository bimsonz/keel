import { describe, expect, it } from "vitest";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { createRng } from "../../fixtures/prng.ts";
import type { AgentCard, RunRef } from "../../../src/contract/keel/index.ts";
import { type Cards, agentNamed, agentPageOf, agentsOf } from "../../../src/engine/agents.ts";
import { heldUnder } from "../../../src/engine/holder.ts";
import { World } from "../../../src/engine/world.ts";
import { showing } from "../showing.ts";

const OTTER = "agt_otter";
const HERON = "agt_heron";
/** Who enrolled the heron and stands behind it: in the log Keel reads a member, and on no page. */
const SPONSOR = "usr_sponsor_of_heron";

const FIX: RunRef = { id: "run_fix", label: "fix-auth" };
const BARE: RunRef = { id: "run_bare" };
const DOCS: RunRef = { id: "run_docs", label: "docs" };

const on = (id: string) => ({ kind: "change" as const, id });
const by = (agentId: string): string => `agent:${agentId}`;

/**
 * A log written by hand: two agents and three runs. The otter signed itself up, which no project's log holds,
 * and has two runs here, one it named and one it did not. The heron was enrolled by a member, has one run, and
 * has written under a token that named no run as well. The heron adopts one of the otter's changes. A person
 * and the platform write too.
 */
function handWritten(): World {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(7));
  b.at(0);
  const declare = (id: string, agentId: string, run?: RunRef): void => {
    b.after(1).emit({
      type: "IntentDeclared",
      entity: on(id),
      actor: by(agentId),
      ...(run === undefined ? {} : { run }),
      payload: {
        changeId: id,
        agentId,
        ...(run === undefined ? {} : { run }),
        origin: "agent",
        revision: 1,
        goal: `goal of ${id}`,
        footprint: [],
        premises: [],
        leaseId: "l",
      },
    });
  };
  const start = (id: string, agentId: string, run?: RunRef): void => {
    b.after(1).emit({
      type: "ChangeStarted",
      entity: on(id),
      actor: by(agentId),
      ...(run === undefined ? {} : { run }),
      payload: { changeId: id, workspaceId: `ws_${id}` },
    });
  };

  // What Keel reads a member: who enrolled the heron and stands behind it.
  b.emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: HERON },
    actor: `user:${SPONSOR}`,
    payload: {
      agentId: HERON,
      projectId: "prj_1",
      name: "Enrolled Heron",
      kind: "hosted",
      scopes: ["agent:work"],
      sponsor: SPONSOR,
    },
  });
  b.after(1);

  // The otter: three entries under the run it named, one under the run it did not.
  declare("chg_1", OTTER, FIX);
  start("chg_1", OTTER, FIX);
  declare("chg_2", OTTER, BARE);
  b.after(1).emit({
    type: "ChangeWithdrawn",
    entity: on("chg_5"),
    actor: by(OTTER),
    run: FIX,
    payload: { changeId: "chg_5", by: by(OTTER), reason: "not needed" },
  });

  // The heron: two entries under no run, then its one run.
  declare("chg_4", HERON);
  start("chg_4", HERON);
  declare("chg_3", HERON, DOCS);
  start("chg_3", HERON, DOCS);
  // It adopts the otter's second change, under its own run.
  b.after(1).emit({
    type: "ChangeAdopted",
    entity: on("chg_2"),
    actor: by(HERON),
    run: DOCS,
    payload: {
      changeId: "chg_2",
      previousAgentId: OTTER,
      agentId: HERON,
      run: DOCS,
      leaseId: "l2",
      briefRef: "brief",
    },
  });
  // The heron's first change lands: it holds it still, and it may no longer land.
  b.after(1).emit({
    type: "ChangeLanded",
    entity: on("chg_3"),
    payload: {
      changeId: "chg_3",
      commitSha: "c3",
      trunkSha: "t3-0000000",
      candidateId: "cnd_1",
      proofId: "prf_1",
    },
  });
  // A person writes, and so does the platform: neither is an agent's work.
  b.after(1).emit({
    type: "ChangeStarted",
    entity: on("chg_1"),
    actor: `user:${SPONSOR}`,
    payload: { changeId: "chg_1", workspaceId: "ws_person" },
  });

  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

/** Keel's cards. An agent that signed itself up has a handle; one a member enrolled has a kind and a namespace. */
const OTTER_CARD: AgentCard = { id: OTTER, name: "Otter", handle: "tidy-otter" };
const HERON_CARD: AgentCard = { id: HERON, name: "Heron", kind: "hosted", namespace: "acme" };
const NO_CARDS: Cards = new Map();
const CARDS: Cards = new Map([
  [OTTER, OTTER_CARD],
  [HERON, HERON_CARD],
]);

describe("a project's agents, folded from its log", () => {
  it("[agents.rows] lists one row for each agent the log names, the one that wrote last first", () => {
    const rows = agentsOf(handWritten(), CARDS);
    expect(rows.map((row) => row.id)).toEqual([HERON, OTTER]);
    expect(rows.map((row) => row.runs)).toEqual([1, 2]);
    // The heron holds three changes, one of them landed; the otter was left with one.
    expect(rows.map((row) => row.changes)).toEqual([3, 1]);
    expect(rows.map((row) => row.holds.map((change) => change.id))).toEqual([
      ["chg_2", "chg_4"],
      ["chg_1"],
    ]);
    // A person's entry on the otter's change, written last of all, is not the otter's.
    expect(rows[1]?.lastAt).toBe("2026-10-13T16:00:05.000Z");
    expect(rows[0]?.lastAt).toBe("2026-10-13T16:00:10.000Z");
  });

  it("[agents.card] names an agent from Keel's card of it, and until the card is read by its id alone", () => {
    const world = handWritten();
    const before = agentsOf(world, NO_CARDS).find((row) => row.id === OTTER);
    expect(before).toMatchObject({ name: OTTER });
    for (const field of ["label", "handle", "kind", "namespace"])
      expect(before).not.toHaveProperty(field);
    const after = agentsOf(world, CARDS);
    // One that signed itself up has a handle, which is what an address calls it.
    expect(after.find((row) => row.id === OTTER)).toMatchObject({
      name: "tidy-otter",
      handle: "tidy-otter",
      label: "Otter",
    });
    // One a member enrolled has the kind it declared and the namespace it works in, and no handle.
    const heron = after.find((row) => row.id === HERON);
    expect(heron).toMatchObject({ name: HERON, label: "Heron", kind: "hosted", namespace: "acme" });
    expect(heron).not.toHaveProperty("handle");
    // A card Keel has none of leaves the agent as the log has it.
    expect(agentsOf(world, new Map([[OTTER, null]])).find((row) => row.id === OTTER)).toEqual(
      before,
    );
  });

  it("[agents.enrolled] names an agent as the log enrolled it while its card is not read", () => {
    const heron = agentsOf(handWritten(), NO_CARDS).find((row) => row.id === HERON);
    expect(heron).toMatchObject({ name: HERON, label: "Enrolled Heron" });
    // The kind a member enrolled it under is not said to be the agent's own declaration.
    expect(heron).not.toHaveProperty("kind");
  });

  it("[agents.named] finds an agent by Keel's id for it or by its card's handle, and nobody by another name", () => {
    const world = handWritten();
    expect(agentNamed(world, CARDS, "tidy-otter")).toBe(OTTER);
    expect(agentNamed(world, CARDS, OTTER)).toBe(OTTER);
    expect(agentNamed(world, CARDS, HERON)).toBe(HERON);
    // Before its card is read the otter has no handle to be found by.
    expect(agentNamed(world, NO_CARDS, "tidy-otter")).toBeUndefined();
    // A card for an agent that has written nothing here names no agent of this project.
    const elsewhere: Cards = new Map([["agt_else", { id: "agt_else", name: "E", handle: "far" }]]);
    expect(agentNamed(world, elsewhere, "far")).toBeUndefined();
    expect(agentNamed(world, CARDS, "nobody")).toBeUndefined();
    expect(agentPageOf(world, CARDS, "nobody")).toBeNull();
    // Who stands behind an agent is a person, and no agent of the project.
    expect(agentPageOf(world, CARDS, SPONSOR)).toBeNull();
  });

  it("[agents.runs] gives each run its label as the agent gave it, its entries, and the changes it holds", () => {
    const page = agentPageOf(handWritten(), CARDS, "tidy-otter");
    expect(page?.runs).toEqual([
      {
        id: "run_fix",
        label: "fix-auth",
        anchor: "run-run_fix",
        firstAt: "2026-10-13T16:00:02.000Z",
        lastAt: "2026-10-13T16:00:05.000Z",
        entries: 3,
        changes: [
          { id: "chg_1", label: "hg_1", name: "hg_1", goal: "goal of chg_1", state: "working" },
        ],
      },
      {
        id: "run_bare",
        anchor: "run-run_bare",
        firstAt: "2026-10-13T16:00:04.000Z",
        lastAt: "2026-10-13T16:00:04.000Z",
        entries: 1,
        changes: [],
      },
    ]);
    // Every entry of the otter's named a run.
    expect(page).not.toHaveProperty("unnamed");
  });

  it("[agents.adopted] moves a change to the run of whoever adopts it", () => {
    const world = handWritten();
    const heron = agentPageOf(world, CARDS, HERON);
    expect(heron?.runs.map((run) => [run.id, run.entries, run.changes.map((c) => c.id)])).toEqual([
      ["run_docs", 3, ["chg_2", "chg_3"]],
    ]);
    const adopted = world.changes.get("chg_2");
    expect(adopted === undefined ? undefined : heldUnder(CARDS, adopted)).toEqual({
      agent: HERON,
      run: { id: "run_docs", label: "docs", anchor: "run-run_docs" },
    });
  });

  it("[agents.adopted-bare] holds a change under no run once it is adopted with a token that named none", () => {
    const world = handWritten();
    world.apply(
      {
        eventId: "evt_last",
        type: "ChangeAdopted",
        entity: on("chg_1"),
        seq: 99,
        at: "2026-10-13T16:01:00.000Z",
        actor: by(HERON),
        payload: {
          _tag: "ChangeAdopted",
          changeId: "chg_1",
          previousAgentId: OTTER,
          agentId: HERON,
          leaseId: "l3",
          briefRef: "brief",
        },
      },
      60_000,
    );
    const taken = world.changes.get("chg_1");
    expect(taken === undefined ? undefined : heldUnder(CARDS, taken)).toEqual({
      agent: HERON,
    });
    expect(agentPageOf(world, CARDS, "tidy-otter")?.runs.map((run) => run.changes)).toEqual([
      [],
      [],
    ]);
  });

  it("[agents.unnamed] lists work under a token that named no run as that, and under no run of the agent's", () => {
    const page = agentPageOf(handWritten(), CARDS, HERON);
    expect(page?.unnamed).toEqual({
      entries: 2,
      changes: [
        { id: "chg_4", label: "hg_4", name: "hg_4", goal: "goal of chg_4", state: "working" },
      ],
    });
  });

  it("[agents.fixture] asks a test fixture for no card, names its agents as its log enrolled them, and still says a handle was looked for", async () => {
    const player = showing(createMockSource({ scenario: "s1", seed: 42 }));
    await player.load();
    player.seek(470_000);
    player.wantCards([...player.world.work.keys()]);
    player.wantAgentAt("nobody");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([player.cards.size, player.sought.has("nobody")]).toEqual([0, true]);
    expect(
      agentsOf(player.world, player.cards).map((row) => [row.label, row.runs, row.holds.length]),
    ).toEqual([
      ["Agent A", 1, 1],
      ["Agent B", 0, 1],
    ]);
  });

  it("[agents.no-sponsor] shows nothing of who stands behind an agent, to a member either", () => {
    const world = handWritten();
    // The log this reader was given holds the heron's enrolment, which names its sponsor.
    expect(world.agents.get(HERON)?.name).toBe("Enrolled Heron");
    for (const cards of [NO_CARDS, CARDS]) {
      const shown = JSON.stringify([
        agentsOf(world, cards),
        agentPageOf(world, cards, OTTER),
        agentPageOf(world, cards, HERON),
      ]);
      expect(shown).toContain(HERON);
      expect(shown).not.toContain(SPONSOR);
    }
  });
});
