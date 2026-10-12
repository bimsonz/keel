import { describe, expect, it } from "vitest";
import { changePageOf, conflictPageOf } from "../../../../src/engine/select.ts";
import type { Resources } from "../../../../src/engine/select.ts";
import { World } from "../../../../src/engine/world.ts";
import { createMockSource } from "../../../fixtures/mock/MockSource.ts";
import { checkLog } from "../../../fixtures/mock/conformance.ts";
import { generateS5 } from "../../../fixtures/mock/same.ts";
import type { ScriptedEvent } from "../../../fixtures/mock/scripted.ts";
import { showing } from "../../showing.ts";

const NOTHING_READ: Resources = {
  diffs: new Map(),
  probes: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

/** What Keel names to a change's agent about another with its intent, in its own words. */
const WAYS_FORWARD = [
  "Read the other change: its intent, its state and its evidence",
  "Read what is near your change, the other change included",
  "Rebase your change onto trunk as it is now",
  "Withdraw your change",
];

/** Scenario 5 as told, or as `rewrite` leaves it, folded into a world with nothing of the console's own beside it. */
function folded(rewrite: (events: ScriptedEvent[]) => ScriptedEvent[] = (events) => events): World {
  const world = new World();
  for (const event of rewrite(structuredClone(generateS5(42).events))) world.apply(event, 0);
  return world;
}

const idOf = (world: World, label: string): string =>
  [...world.changes.values()].find((change) => change.label === label)?.id ?? "";

/** The alternatives a change's page lists, as `#n state`, in the order the page gives them. */
const listed = (world: World, label: string): string[] | undefined =>
  changePageOf(world, idOf(world, label), NOTHING_READ)?.sameIntent?.others.map(
    (other) => `${other.label} ${other.state}`,
  );

describe("scenario 5: the same intent", () => {
  it("[same.conforms] conforms to the catalogue and the state machines, and is told the same way twice", () => {
    expect(checkLog(generateS5(42).events)).toEqual([]);
    expect(JSON.stringify(generateS5(42).events)).toBe(JSON.stringify(generateS5(42).events));
  });

  it("[same.told] lists on each change the others Keel told it have its intent, each as it stands now", () => {
    const world = folded();
    // #1 was declared first and learnt of the others by notice. #3 was given both at its preflight.
    expect(listed(world, "#1")).toEqual(["#2 withdrawn", "#3 working"]);
    expect(listed(world, "#2")).toEqual(["#1 landed", "#3 working"]);
    expect(listed(world, "#3")).toEqual(["#1 landed", "#2 withdrawn"]);
    // The same subject and predicate with another value is another claim: #4 is no one's alternative.
    expect(changePageOf(world, idOf(world, "#4"), NOTHING_READ)?.sameIntent).toBeUndefined();
    expect(
      [...world.changes.values()].flatMap((change) =>
        change.alternatives.map((other) => other.changeId),
      ),
    ).not.toContain(idOf(world, "#4"));
  });

  it("[same.not-inferred] shows a change only what Keel told that change, and infers nothing from the other side", () => {
    // Keel's notice to #1 about #2 never arrives. #2's own preflight still names #1.
    const world = folded((events) =>
      events.filter(
        (event) =>
          !(
            event.type === "AlternativeDeclared" &&
            event.payload.alternativeId === idOf(folded(), "#2")
          ),
      ),
    );
    expect(listed(world, "#2")).toEqual(["#1 landed", "#3 working"]);
    expect(listed(world, "#1")).toEqual(["#3 working"]);
  });

  it("[same.order] keeps the order Keel named them in, and ranks nothing", () => {
    // Keel lists #3's alternatives the other way round: the landed one is not moved to the front.
    const world = folded((events) => {
      for (const event of events)
        if (event.type === "PreflightIssued" && event.payload.alternatives?.length === 2)
          event.payload.alternatives = event.payload.alternatives.toReversed();
      return events;
    });
    expect(listed(world, "#3")).toEqual(["#2 withdrawn", "#1 landed"]);
  });

  it("[same.landed] says which alternative Keel told a change had landed, with the ways forward Keel gave", () => {
    const world = folded();
    const page = changePageOf(world, idOf(world, "#3"), NOTHING_READ);
    const [one, two] = page?.sameIntent?.others ?? [];
    expect(one).toMatchObject({
      label: "#1",
      state: "landed",
      verdict: { outcome: "land", evidence: 1 },
      conflicts: 0,
      next: WAYS_FORWARD,
    });
    expect(one?.landed).toBeDefined();
    // #2 was on #3's preflight and Keel has said nothing more of it to #3.
    expect(two).toMatchObject({ label: "#2", state: "withdrawn", next: [] });
    expect(two).not.toHaveProperty("landed");
    expect(two).not.toHaveProperty("verdict");
    expect(page?.sameIntent?.self).toMatchObject({ label: "#3", state: "working" });
  });

  it("[same.preflight-replaces] takes a later preflight as Keel's whole word, and keeps what it said of a change still listed", () => {
    const revised = (alternatives: (ids: { one: string }) => string[] | undefined) =>
      folded((events) => {
        const world = folded();
        const three = idOf(world, "#3");
        const last = events.findLast((event) => event.type === "PreflightIssued");
        if (last?.type !== "PreflightIssued") return events;
        const again = alternatives({ one: idOf(world, "#1") });
        return [
          ...events,
          {
            ...last,
            entity: { kind: "change", id: three },
            payload: {
              ...last.payload,
              changeId: three,
              revision: 2,
              ...(again === undefined ? {} : { alternatives: again }),
            },
          },
        ];
      });
    // Revised away from the shared intent: Keel lists none, and the page lists none.
    const apart = revised(() => undefined);
    expect(changePageOf(apart, idOf(apart, "#3"), NOTHING_READ)?.sameIntent).toBeUndefined();
    // Still an alternative to #1 alone: what Keel told #3 of #1's landing is kept.
    const still = revised(({ one }) => [one]);
    const others = changePageOf(still, idOf(still, "#3"), NOTHING_READ)?.sameIntent?.others;
    expect(others?.map((other) => other.label)).toEqual(["#1"]);
    expect(others?.[0]?.landed).toBeDefined();
  });
});

/** What Keel told each side of a scenario's one conflict, A then B, at an instant. */
const sides = async (scenario: "s1" | "s3" | "s4", seconds: number) => {
  const player = showing(createMockSource({ scenario, seed: 42 }));
  await player.load();
  player.seek(seconds * 1000);
  const [conflict] = [...player.world.conflicts.values()];
  const parties = conflictPageOf(player.world, conflict?.id ?? "", player)?.parties;
  return [parties?.A.told, parties?.B.told];
};

describe("what Keel told each side of a conflict", () => {
  const KEELS = [
    "Read the conflict and the proof against the change",
    "Revise the change's intent around the conflict",
    "Resolve the conflict with a move",
  ];

  it("[conflict.told] gives the ways forward Keel's own event carried, and says nothing where Keel told no one", async () => {
    expect(await sides("s3", 495)).toEqual([
      { how: "noted", next: KEELS },
      { how: "noted", next: KEELS },
    ]);
    expect(await sides("s4", 460)).toEqual([
      { how: "bounced", next: KEELS },
      { how: "bounced", next: KEELS },
    ]);
    // Scenario 1 at the question: Keel has parked both sides and told neither a way forward on the conflict.
    expect(await sides("s1", 470)).toEqual([undefined, undefined]);
  });
});
