import { describe, expect, it } from "vitest";
import type { Player } from "../../../src/engine/player.ts";
import { changePageOf, conflictPageOf } from "../../../src/engine/select.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { generateS1 } from "../../fixtures/mock/s1.ts";
import { createRng } from "../../fixtures/prng.ts";
import { showing } from "../showing.ts";

/** Scenario 1 with conflict C-1 proven, and one more change, #3, that Keel then holds C-1 against. */
async function proven(): Promise<{ player: Player; conflictId: string; changeId: string }> {
  const player = showing(createMockSource({ scenario: "s1", seed: 42 }));
  await player.load();
  player.seek(446_000);
  const conflict = [...player.world.conflicts.values()].find((held) => held.label === "C-1");
  if (conflict === undefined) throw new Error("scenario 1 has no C-1 by then");
  const b = new ScriptBuilder("2026-10-13T16:10:00.000Z", createRng(7));
  b.at(1).emit({
    type: "IntentDeclared",
    entity: { kind: "change", id: "chg_3" },
    label: "#3",
    payload: {
      changeId: "chg_3",
      agentId: [...player.world.agents.keys()][0] ?? "",
      origin: "agent",
      leaseId: "lse_3",
      goal: "Read roles once a session",
      footprint: [],
      premises: [],
      revision: 1,
    },
  });
  const log = b.build();
  log.events.forEach((event, index) => player.world.apply(event, log.eventTimes[index] ?? 0));
  return { player, conflictId: conflict.id, changeId: "chg_3" };
}

function then(player: Player, emit: (b: ScriptBuilder) => void): void {
  const b = new ScriptBuilder("2026-10-13T16:11:00.000Z", createRng(8));
  emit(b);
  const log = b.build();
  log.events.forEach((event, index) => player.world.apply(event, log.eventTimes[index] ?? 0));
}

describe("a conflict proven against a change", () => {
  it("[change.bounce-conflict] ties a bounce to the conflict Keel names, and gives it no verdict", async () => {
    const { player, conflictId, changeId } = await proven();
    then(player, (b) =>
      b.at(1).emit({
        type: "ChangeBounced",
        entity: { kind: "change", id: changeId },
        payload: { changeId, conflictId, reasons: [`cfl:${conflictId}`] },
      }),
    );
    const page = changePageOf(player.world, changeId, player);
    expect(page?.change.state).toBe("bounced");
    expect(page?.bounce?.conflict).toEqual({
      id: conflictId,
      label: "C-1",
      predicate: "freshness",
    });
    expect(page?.conflict).toMatchObject({ id: conflictId, label: "C-1" });
    expect(page?.verdict).toBeUndefined();
  });

  it("[change.bounce-verdict] leaves a bounce on a verdict as the verdict's, with no conflict named for it", async () => {
    const log = generateS1(42, "invalidate");
    const at = log.events.findIndex((event) => event.type === "ChangeBounced");
    const first = log.events[at];
    if (first?.type !== "ChangeBounced") throw new Error("scenario 1 bounces nothing");
    const player = showing(createMockSource({ scenario: "s1", seed: 42, ruling: "invalidate" }));
    await player.load();
    player.seek((log.eventTimes[at] ?? 0) + 50);
    const page = changePageOf(player.world, first.payload.changeId, player);
    expect(page?.change.state).toBe("bounced");
    expect(page?.bounce).toEqual({
      at: first.at,
      next: first.payload.nextActions?.map((action) => action.title),
    });
    expect(page?.bounce?.next.length).toBeGreaterThan(0);
    expect(page?.verdict?.id).toBe(first.payload.verdictId);
  });

  it("[change.bounce-refused] says a change's batch was refused its push, and shows no earlier verdict as the cause", async () => {
    const { player, changeId } = await proven();
    then(player, (b) => {
      b.at(1).emit({
        type: "VerdictIssued",
        entity: { kind: "verdict", id: "vrd_3" },
        payload: { verdictId: "vrd_3", subject: changeId, outcome: "land", evidence: [] },
      });
      b.at(2).emit({
        type: "ChangeBounced",
        entity: { kind: "change", id: changeId },
        payload: {
          changeId,
          declined: { batchId: "bat_3", reason: "repo-bytes-quota" },
          reasons: ["The repo is at its size quota."],
          nextActions: [{ kind: "call", title: "Submit the change again once there is room" }],
        },
      });
    });
    const page = changePageOf(player.world, changeId, player);
    expect(page?.change.state).toBe("bounced");
    expect(page?.bounce).toEqual({
      at: page?.bounce?.at,
      refused: "repo-bytes-quota",
      next: ["Submit the change again once there is room"],
    });
    expect(page?.verdict).toBeUndefined();
  });

  it("[change.noted] shows a conflict Keel noted against a change and let it go on, with the policy that let it", async () => {
    const { player, conflictId, changeId } = await proven();
    then(player, (b) =>
      b.at(1).emit({
        type: "ConflictNoted",
        entity: { kind: "change", id: changeId },
        payload: { changeId, conflictId, predicate: "freshness", policy: "advise" },
      }),
    );
    const page = changePageOf(player.world, changeId, player);
    expect(page?.noted).toEqual([
      {
        conflict: { id: conflictId, label: "C-1" },
        predicate: "freshness",
        policy: "advise",
        at: page?.noted[0]?.at,
        next: [],
      },
    ]);
    // It is not a bounce, and the change stands as it stood.
    expect(page?.bounce).toBeUndefined();
    expect(page?.change.state).not.toBe("bounced");
    // The conflict's own page says so too, in what happened.
    expect(
      conflictPageOf(player.world, conflictId, player)?.timeline.map((item) => item.title),
    ).toContain("Noted against #3");
  });
});

describe("a conflict, once settled", () => {
  it("[conflict.after] keeps the matrix as the probe left it, and says what came of each side from the verdicts given since", async () => {
    const log = generateS1(42, "invalidate");
    const settled = log.eventTimes[log.events.findIndex((e) => e.type === "ConflictResolved")] ?? 0;
    const player = showing(createMockSource({ scenario: "s1", seed: 42, ruling: "invalidate" }));
    await player.load();
    const page = () => {
      const [conflict] = [...player.world.conflicts.values()];
      return conflictPageOf(player.world, conflict?.id ?? "", player);
    };
    const after = () => page()?.after.map((side) => [side.label, side.revision, side.outcome]);
    // Just settled: the verdict that parked #1 was given before, and is not what came of the conflict.
    player.seek(settled + 10);
    expect(page()?.conflict.state).toBe("resolved");
    expect(after()).toEqual([]);
    // The ruling bounces #1, and #2 lands as it was.
    player.seek(640_000);
    expect(after()).toEqual([
      ["#2", 1, "land"],
      ["#1", 1, "bounce"],
    ]);
    // #1 comes back revised and lands: that verdict is where it is seen to pass.
    player.seek(700_000);
    expect(after()).toEqual([
      ["#2", 1, "land"],
      ["#1", 2, "land"],
    ]);
    // Keel ran nothing in the matrix's worlds after the conflict was settled, so the proof stands in it.
    expect(page()?.matrix.cells.AB.probe).toMatchObject({ runs: ["fail", "fail", "fail"] });
  });
});
