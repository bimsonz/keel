// A preflight may carry `compared`: how many live changes it read near the intent, and how many subject
// keys they were under. The console folds that onto the change's entry, and a preflight without it leaves
// nothing there. Each case here is a log written by hand for the one point it makes.

import { describe, expect, it } from "vitest";
import { createRng } from "../../fixtures/prng.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { World } from "../../../src/engine/world.ts";

/** A change declared and then prefighted, folded as the page folds it. */
function foldedPreflight(compared?: { changes: number; subjects: number }): World {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(1));
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
  b.after(1).emit({
    type: "IntentDeclared",
    entity: { kind: "change", id: "chg_1" },
    payload: {
      changeId: "chg_1",
      agentId: "agt_1",
      origin: "agent",
      revision: 1,
      goal: "chg_1",
      footprint: [],
      premises: [],
      leaseId: "l",
    },
  });
  b.after(0.2).emit({
    type: "PreflightIssued",
    entity: { kind: "change", id: "chg_1" },
    payload: {
      changeId: "chg_1",
      revision: 1,
      neighbours: [],
      contradictions: [],
      precedents: [],
      suggestedMove: "proceed",
      ...(compared === undefined ? {} : { compared }),
    },
  });
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

describe("a preflight's compared", () => {
  it("keeps what a preflight compared on the change it was issued for", () => {
    const world = foldedPreflight({ changes: 3, subjects: 2 });
    expect(world.changes.get("chg_1")?.compared).toEqual({ changes: 3, subjects: 2 });
  });

  it("leaves nothing there when the preflight carried no compared", () => {
    const world = foldedPreflight();
    expect(world.changes.get("chg_1")?.compared).toBeUndefined();
  });
});
