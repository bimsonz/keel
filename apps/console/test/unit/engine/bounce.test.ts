import { describe, expect, it } from "vitest";
import type { Player } from "../../../src/engine/player.ts";
import { changePageOf, conflictPageOf } from "../../../src/engine/select.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { S1_CHOICES, generateS1 } from "../../fixtures/mock/s1.ts";
import { generateS2 } from "../../fixtures/mock/s2.ts";
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
    const log = generateS2(42);
    const at = log.events.findIndex(
      (event) => event.type === "ChangeBounced" && event.payload.verdictId !== undefined,
    );
    const first = log.events[at];
    if (first?.type !== "ChangeBounced") throw new Error("scenario 2 bounces nothing on a verdict");
    const player = showing(createMockSource({ scenario: "s2", seed: 42 }));
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

  it("[change.bounce-cites] names the decision a verdict's bounce cites, from Keel's next action, and leaves the bounce the verdict's", async () => {
    const { player, changeId } = await proven();
    const bounced = (
      nextActions: {
        kind: "read" | "call";
        title: string;
        operationId?: string;
        args?: Record<string, unknown>;
      }[],
    ): void =>
      then(player, (b) =>
        b.at(1).emit({
          type: "ChangeBounced",
          entity: { kind: "change", id: changeId },
          payload: {
            changeId,
            verdictId: "vdt_guard",
            reasons: ["guard G-1 failed: holds decision dec_01: permissions are read fresh"],
            nextActions,
          },
        }),
      );
    bounced([
      { kind: "call", title: "Revise the change", operationId: "Changes_revise" },
      {
        kind: "read",
        title: "Read the decision this guard holds",
        operationId: "Memory_getDecision",
        args: { decisionId: "dec_01" },
      },
    ]);
    const page = changePageOf(player.world, changeId, player);
    expect(page?.bounce?.cites).toBe("dec_01");
    // The cause is the verdict's still: no ruling and no conflict is named for it.
    expect(page?.bounce?.ruling).toBe(undefined);
    expect(page?.bounce?.conflict).toBe(undefined);
    expect(player.world.changes.get(changeId)?.bounces).toMatchObject({ verdict: 1, ruling: 0 });
    // A later bounce that says to read no decision cites none, whatever its reasons say.
    bounced([{ kind: "call", title: "Revise the change", operationId: "Changes_revise" }]);
    expect(changePageOf(player.world, changeId, player)?.bounce).not.toHaveProperty("cites");
  });

  it("[change.bounce-ruling] says a ruling went against a change by its decision, with the conflict that decision settled and Keel's reason, and shows no earlier verdict as the cause", async () => {
    const log = generateS1(42, "invalidate");
    const at = log.events.findIndex((event) => event.type === "ChangeBounced");
    const first = log.events[at];
    if (first?.type !== "ChangeBounced") throw new Error("scenario 1 bounces nothing");
    const player = showing(createMockSource({ scenario: "s1", seed: 42, ruling: "invalidate" }));
    await player.load();
    player.seek((log.eventTimes[at] ?? 0) + 50);
    const [conflict] = [...player.world.conflicts.values()];
    const page = changePageOf(player.world, first.payload.changeId, player);
    expect(page?.change.state).toBe("bounced");
    expect(first.payload.decisionId).toBeDefined();
    expect(page?.bounce).toEqual({
      at: first.at,
      ruling: {
        decision: { label: "D-1", chosen: "Cache allowed if revocation invalidates it" },
        conflict: { id: conflict?.id, label: "C-1" },
        reasons: [S1_CHOICES.find((option) => option.id === "invalidate")?.consequence],
      },
      next: first.payload.nextActions?.map((action) => action.title),
    });
    expect(page?.bounce?.next.length).toBeGreaterThan(0);
    // The verdict that sent it to its wait was given before the ruling, and is not this bounce's.
    expect(player.world.changes.get(first.payload.changeId)?.verdictIds.length).toBeGreaterThan(0);
    expect(page?.verdict).toBeUndefined();
  });

  it("[change.bounce-ruling-alone] says of a ruling's bounce only what the log holds: no decision and no conflict it has not read", async () => {
    // Keel's objects write in no fixed order, so a bounce can be read before the resolution and the decision.
    // A conflict some other decision settled is not the one this bounce's decision did.
    const { player, conflictId, changeId } = await proven();
    then(player, (b) => {
      b.at(1).emit({
        type: "ConflictResolved",
        entity: { kind: "conflict", id: conflictId },
        payload: { conflictId, move: "yield", decisionId: "dec_other" },
      });
      b.at(2).emit({
        type: "ChangeBounced",
        entity: { kind: "change", id: changeId },
        payload: {
          changeId,
          decisionId: "dec_unread",
          reasons: ["It cannot land as written."],
          nextActions: [{ kind: "call", title: "Revise the intent" }],
        },
      });
    });
    const page = changePageOf(player.world, changeId, player);
    expect(page?.bounce).toEqual({
      at: page?.bounce?.at,
      ruling: { reasons: ["It cannot land as written."] },
      next: ["Revise the intent"],
    });
    expect(page?.verdict).toBeUndefined();
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

/** Scenario 1 under a ruling: what the conflict's page says the ruling did to each side, A then B, at a time. */
async function ruledOn(ruling: "invalidate" | "allow-stale") {
  const log = generateS1(42, ruling);
  const settled = log.eventTimes[log.events.findIndex((e) => e.type === "ConflictResolved")];
  const bounced = log.events.find((event) => event.type === "ChangeBounced");
  if (bounced?.type !== "ChangeBounced") throw new Error("scenario 1 bounces nothing");
  const player = showing(createMockSource({ scenario: "s1", seed: 42, ruling }));
  await player.load();
  const sides = (at: number) => {
    player.seek(at);
    const [conflict] = [...player.world.conflicts.values()];
    const parties = conflictPageOf(player.world, conflict?.id ?? "", player)?.parties;
    return [parties?.A.ruledAgainst, parties?.B.ruledAgainst];
  };
  const next = bounced.payload.nextActions?.map((action) => action.title) ?? [];
  return { sides, settled: settled ?? 0, next };
}

describe("a conflict, once settled", () => {
  it("[conflict.ruled-against] says on the side its resolution names that the ruling went against it, with what its agent was told, and nothing on the other side", async () => {
    // The premise stands: against #1, which makes the effect and is the page's side B.
    const kept = await ruledOn("invalidate");
    expect(kept.next.length).toBeGreaterThan(0);
    // The resolution alone names the side. The decision and the bounce are not read yet, so neither is said.
    expect(kept.sides(kept.settled + 10)).toEqual([undefined, { next: [] }]);
    expect(kept.sides(640_000)).toEqual([undefined, { decision: "D-1", next: kept.next }]);
    // #1 came back revised and landed: the ruling still went against it.
    expect(kept.sides(700_000)).toEqual([undefined, { decision: "D-1", next: kept.next }]);
    // The effect stands: against #2, which holds the premise and is side A.
    const relaxed = await ruledOn("allow-stale");
    expect(relaxed.sides(640_000)).toEqual([{ decision: "D-1", next: relaxed.next }, undefined]);
  });

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
    // The ruling bounces #1 by its decision, with no verdict, and #2 lands as it was.
    player.seek(640_000);
    expect(after()).toEqual([["#2", 1, "land"]]);
    // #1 comes back revised and lands: that verdict is where it is seen to pass.
    player.seek(700_000);
    expect(after()).toEqual([
      ["#2", 1, "land"],
      ["#1", 2, "land"],
    ]);
    // Keel ran nothing in the matrix's worlds after the conflict was settled, so the proof stands in it.
    expect(page()?.matrix.rows.find((row) => row.id === "AB")?.runs).toEqual([
      "fail",
      "fail",
      "fail",
    ]);
  });
});
