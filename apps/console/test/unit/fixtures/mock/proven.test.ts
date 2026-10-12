import { describe, expect, it } from "vitest";
import type { EventType } from "../../../../src/contract/envelope.ts";
import type { Player } from "../../../../src/engine/player.ts";
import { changePageOf, conflictPageOf } from "../../../../src/engine/select.ts";
import type { GeneratedLog } from "../../../fixtures/mock/builder.ts";
import { type Scenario, createMockSource } from "../../../fixtures/mock/MockSource.ts";
import { checkLog, finalStates } from "../../../fixtures/mock/conformance.ts";
import { generateS3, generateS4 } from "../../../fixtures/mock/proven.ts";
import { generateS1 } from "../../../fixtures/mock/s1.ts";
import { showing } from "../../showing.ts";

/** What Keel names to a change a conflict was proven against, in its own words. */
const WAYS_FORWARD = [
  "Read the conflict and the proof against the change",
  "Revise the change's intent around the conflict",
  "Resolve the conflict with a move",
];

async function ended(scenario: Scenario, log: GeneratedLog): Promise<Player> {
  const player = showing(createMockSource({ scenario, seed: 42 }));
  await player.load();
  player.seek(log.end);
  return player;
}

/** The state each change ends in, by its number. */
function changesOf(log: GeneratedLog): Record<string, string | undefined> {
  const states = finalStates(log.events);
  return Object.fromEntries(
    log.events
      .filter((event) => event.type === "IntentDeclared")
      .map((event) => [event.label ?? "", states.get(`change:${event.payload.changeId}`)]),
  );
}

const typesTo = (log: GeneratedLog, last: EventType): EventType[] => {
  const types = log.events.map((event) => event.type);
  return types.slice(0, types.indexOf(last) + 1);
};

/** The predicate policy each plan compiled, in the order the plans were compiled. */
const policies = (log: GeneratedLog) =>
  log.events
    .filter((event) => event.type === "PlanCompiled")
    .map((event) => event.payload.predicatePolicy);

describe("scenarios 3 and 4: what a proof does to a change", () => {
  it("[proven.conforms] conform to the catalogue and the state machines, and are told the same way twice", () => {
    for (const generate of [generateS3, generateS4]) {
      expect(checkLog(generate(42).events)).toEqual([]);
      expect(JSON.stringify(generate(42).events)).toBe(JSON.stringify(generate(42).events));
      expect(generate(42).gates).toEqual([]);
    }
  });

  it("open as scenario 1 does, up to the proof, and differ only in the policy each plan compiled", () => {
    const first = typesTo(generateS1(42), "ConflictProven");
    expect(typesTo(generateS3(42), "ConflictProven")).toEqual(first);
    expect(typesTo(generateS4(42), "ConflictProven")).toEqual(first);
    expect(policies(generateS3(42))).toEqual([undefined, undefined]);
    expect(policies(generateS4(42))).toEqual([{ freshness: "block" }, { freshness: "block" }]);
  });

  it("[proven.advise] notes the conflict on both changes when their plans say nothing of its predicate, and holds neither", async () => {
    const log = generateS3(42);
    const proven = log.events.find((event) => event.type === "ConflictProven");
    const probe = proven?.payload.evidence._tag === "probe" ? proven.payload.evidence.probeId : "";
    const noted = log.events.filter((event) => event.type === "ConflictNoted");
    expect(
      noted.map((event) => [event.label, event.payload.policy, event.payload.evidenceRef]),
    ).toEqual([
      [undefined, "advise", `probe:${probe}`],
      [undefined, "advise", `probe:${probe}`],
    ]);
    expect(noted.map((event) => event.payload.nextActions?.map((action) => action.title))).toEqual([
      WAYS_FORWARD,
      WAYS_FORWARD,
    ]);
    // Nobody is asked, nothing bounces, and the change that altered the subject lands as it was written.
    const types = new Set(log.events.map((event) => event.type));
    expect(types.has("EscalationRaised") || types.has("ChangeBounced")).toBe(false);
    expect(changesOf(log)).toEqual({ "#1": "landed", "#2": "verifying" });

    const player = await ended("s3", log);
    const [conflict] = [...player.world.conflicts.values()];
    const pages = [...player.world.changes.values()].map((change) =>
      changePageOf(player.world, change.id, player),
    );
    expect(pages.map((page) => [page?.change.label, page?.change.state, page?.bounce])).toEqual([
      ["#1", "landed", undefined],
      ["#2", "verifying", undefined],
    ]);
    for (const page of pages) {
      expect(page?.noted).toEqual([
        {
          conflict: { id: conflict?.id, label: "C-1" },
          predicate: "freshness",
          policy: "advise",
          at: page?.noted[0]?.at,
          next: WAYS_FORWARD,
        },
      ]);
    }
    // The conflict stays proven, and its own page says what was done about it.
    const about = conflictPageOf(player.world, conflict?.id ?? "", player);
    expect(about?.conflict.state).toBe("proven");
    expect(about?.timeline.map((item) => item.title)).toEqual(
      expect.arrayContaining(["Noted against #1", "Noted against #2"]),
    );
  });

  it("[proven.block] bounces both changes on the conflict itself when their plans block on its predicate, with no verdict", async () => {
    const log = generateS4(42);
    const proven = log.events.find((event) => event.type === "ConflictProven");
    const bounced = log.events.filter((event) => event.type === "ChangeBounced");
    expect(
      bounced.map((event) => [
        event.payload.conflictId,
        event.payload.verdictId,
        event.payload.declined,
      ]),
    ).toEqual([
      [proven?.payload.conflictId, undefined, undefined],
      [proven?.payload.conflictId, undefined, undefined],
    ]);
    expect(log.events.some((event) => event.type === "VerdictIssued")).toBe(false);
    expect(changesOf(log)).toEqual({ "#1": "bounced", "#2": "bounced" });

    const player = await ended("s4", log);
    const [conflict] = [...player.world.conflicts.values()];
    for (const change of player.world.changes.values()) {
      const page = changePageOf(player.world, change.id, player);
      expect(page?.change.state).toBe("bounced");
      expect(page?.bounce).toEqual({
        at: page?.bounce?.at,
        conflict: { id: conflict?.id, label: "C-1", predicate: "freshness" },
        next: WAYS_FORWARD,
      });
      expect(page?.verdict).toBeUndefined();
      expect(page?.noted).toEqual([]);
    }
    expect(conflictPageOf(player.world, conflict?.id ?? "", player)?.conflict.state).toBe("proven");
  });
});
