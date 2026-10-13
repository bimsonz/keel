import { describe, expect, it } from "vitest";
import type { AgentCard } from "../../../src/contract/keel/index.ts";
import { type Cards, holdersOf } from "../../../src/engine/holder.ts";
import { type Lanes, lanesOf, subjectOf } from "../../../src/engine/lanes.ts";
import { CHANGE_FILTERS, PAGE, changesOf } from "../../../src/engine/lists.ts";
import { type Resources, changePageOf, conflictPageOf } from "../../../src/engine/select.ts";
import { subjectDetailOf } from "../../../src/engine/subject.ts";
import { World } from "../../../src/engine/world.ts";
import type { GeneratedLog } from "../../fixtures/mock/builder.ts";
import { MEMBERS_ONLY } from "../../fixtures/mock/fakeKeel.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";
import { generateS5 } from "../../fixtures/mock/same.ts";

/** Scenario 1 with both changes declared, the conflict between them open and neither landed. */
const MID = 470_000;

/**
 * A log as Keel reads it to a member, or to anyone else: the public part alone, which holds no enrolment. So
 * the second world names each agent by its id and nothing more, as a visitor's does.
 */
function folded(log: GeneratedLog, until: number, reader: "member" | "visitor"): World {
  const world = new World();
  log.events.forEach((event, index) => {
    const at = log.eventTimes[index] ?? 0;
    if (at > until) return;
    if (reader === "visitor" && MEMBERS_ONLY.has(event.type)) return;
    world.apply(event, at);
  });
  return world;
}

const idOf = (world: World, label: string): string =>
  [...world.changes.values()].find((change) => change.label === label)?.id ?? "";
const holderOf = (world: World, label: string): string =>
  world.changes.get(idOf(world, label))?.agentId ?? "";

/** Keel's cards of scenario 1's two agents: one that signed itself up, and one a member enrolled. */
function cardsOf(world: World): Cards {
  const otter: AgentCard = { id: holderOf(world, "#1"), name: "Otter", handle: "tidy-otter" };
  const heron: AgentCard = {
    id: holderOf(world, "#2"),
    name: "Heron",
    kind: "hosted",
    namespace: "ada",
  };
  return new Map([
    [otter.id, otter],
    [heron.id, heron],
  ]);
}

const read = (cards?: Cards): Resources => ({
  diffs: new Map(),
  probes: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
  ...(cards === undefined ? {} : { cards }),
});

const rowsOf = (world: World, cards?: Cards): string[] =>
  CHANGE_FILTERS.flatMap((filter) => changesOf(world, filter, PAGE, cards).rows)
    .map((row) => `${row.label} ${row.agent} ${row.agentClass}`)
    .toSorted();

const sidesOf = (world: World, cards?: Cards): string[] => {
  const page = conflictPageOf(world, [...world.conflicts.keys()][0] ?? "", read(cards));
  return [page?.parties?.A, page?.parties?.B]
    .map((party) => `${party?.label} ${party?.agent.label} ${party?.agent.class}`)
    .toSorted();
};

const agentNodes = (lanes: Lanes): string[] =>
  lanes.lanes
    .flatMap((lane) => lane.nodes)
    .flatMap((node) =>
      node.kind === "agent" ? [`${node.label} ${node.agentClass} ${node.id.split(":")[1]}`] : [],
    )
    .toSorted();

describe("an agent named from Keel's card of it, on every page that names one", () => {
  const visitor = folded(generateS1(42), MID, "visitor");
  const member = folded(generateS1(42), MID, "member");
  const cards = cardsOf(visitor);
  const [otter, heron] = [holderOf(visitor, "#1"), holderOf(visitor, "#2")];

  it("the fixture: a visitor's log enrols nobody, a member's both, and the two changes are two agents'", () => {
    expect([visitor.agents.size, member.agents.size]).toEqual([0, 2]);
    expect(otter).not.toBe(heron);
    expect([otter, heron]).not.toContain("");
    expect(visitor.conflicts.size).toBe(1);
  });

  it("[carded.changes] names each change's agent from its card on the list of changes, with no class, and as an agent until the card is read", () => {
    expect(rowsOf(visitor, cards)).toEqual(["#1 Otter unnamed", "#2 Heron unnamed"]);
    expect(rowsOf(visitor)).toEqual(["#1 an agent unnamed", "#2 an agent unnamed"]);
    // Keel knows no agent by that id: the row says no more than before.
    expect(rowsOf(visitor, new Map([[otter, null]]))).toEqual([
      "#1 an agent unnamed",
      "#2 an agent unnamed",
    ]);
    // A member's log has the enrolment, so the class is written beside the card's name.
    expect(rowsOf(member, cards)).toEqual([
      `#1 Otter ${member.agents.get(otter)?.class}`,
      `#2 Heron ${member.agents.get(heron)?.class}`,
    ]);
  });

  it("[carded.sides] names the agent on each side of a conflict from its own card", () => {
    expect(sidesOf(visitor, cards)).toEqual(["#1 Otter unnamed", "#2 Heron unnamed"]);
    expect(sidesOf(visitor)).toEqual(["#1 Agent unnamed", "#2 Agent unnamed"]);
  });

  it("[carded.change] names a change's agent from its card on the change's own page", () => {
    expect(changePageOf(visitor, idOf(visitor, "#2"), read(cards))?.agent).toEqual({
      label: "Heron",
      class: "unnamed",
      harness: "",
      model: "",
    });
    expect(changePageOf(visitor, idOf(visitor, "#2"), read())?.agent.label).toBe("Agent");
  });

  it("[carded.intent] names the agent of each change with the same intent from its own card", () => {
    const same = folded(generateS5(42), Number.POSITIVE_INFINITY, "visitor");
    const named: Cards = new Map(
      [...same.changes.values()].map((change) => [
        change.agentId,
        { id: change.agentId, name: `Card of ${change.label}` },
      ]),
    );
    const told = [...same.changes.values()].find((change) => change.alternatives.length > 0);
    const page = changePageOf(same, told?.id ?? "", read(named))?.sameIntent;
    expect(page?.others.length).toBeGreaterThan(0);
    for (const row of [page?.self, ...(page?.others ?? [])])
      expect(row?.agent).toEqual({ label: `Card of ${row?.label}`, class: "unnamed", harness: "" });
    const bare = changePageOf(same, told?.id ?? "", read())?.sameIntent;
    expect([bare?.self.agent.label, ...(bare?.others ?? []).map((row) => row.agent.label)]).toEqual(
      Array.from({ length: (bare?.others.length ?? 0) + 1 }, () => "Agent"),
    );
  });

  it("[carded.panel] names each change's agent from its card in a subject's panel", () => {
    const change = visitor.changes.get(idOf(visitor, "#2"));
    const subject = change === undefined ? undefined : subjectOf(change);
    const listed = (given?: Cards): string[] =>
      (subjectDetailOf(visitor, subject ?? "", given)?.changes.listed ?? [])
        .filter((row) => row.label === "#2")
        .map((row) => `${row.agent} ${row.agentClass}`);
    expect(listed(cards)).toEqual(["Heron unnamed"]);
    expect(listed()).toEqual(["an agent unnamed"]);
  });

  it("[carded.node] draws an agent beside its change in Mission Control once the reader has its card, under the card's name and with no class", () => {
    expect(agentNodes(lanesOf(visitor, MID, {}, cards))).toEqual([
      `Heron unnamed ${heron}`,
      `Otter unnamed ${otter}`,
    ]);
    // With no name for it there is nothing to draw: not before its card is read, and not where Keel has none.
    expect(agentNodes(lanesOf(visitor, MID))).toEqual([]);
    expect(agentNodes(lanesOf(visitor, MID, {}, new Map([[otter, null]])))).toEqual([]);
    // A member's log has the enrolment: the class stays, beside the card's name.
    expect(agentNodes(lanesOf(member, MID, {}, cards))).toEqual([
      `Heron ${member.agents.get(heron)?.class} ${heron}`,
      `Otter ${member.agents.get(otter)?.class} ${otter}`,
    ]);
  });

  it("[carded.holders] asks for the card of each agent that holds a change a page shows, once, and of nobody else", () => {
    const [one, two] = [idOf(visitor, "#1"), idOf(visitor, "#2")];
    expect(holdersOf(visitor, [two, one, two, "chg_nobody"])).toEqual([heron, otter]);
    expect(holdersOf(visitor, [one, one])).toEqual([otter]);
    expect(holdersOf(visitor, [])).toEqual([]);
  });
});
