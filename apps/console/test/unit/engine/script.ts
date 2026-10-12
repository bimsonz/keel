// Logs written by hand for one test's point: a few agents, a subject for each key, and changes that rely on
// them. Each event is in Keel's own shape, and is folded as the page folds it.

import { World } from "../../../src/engine/world.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createRng } from "../../fixtures/prng.ts";

export type Premise = { subject: string; predicate: "bound"; relation: "at-most"; value: string };
export const premiseOn = (subject: string, value = "tight"): Premise => ({
  subject,
  predicate: "bound",
  relation: "at-most",
  value,
});

/** A log's opening: its agents, and a subject minted for each key. */
export function openingOf(
  seed: number,
  agents: [string, "hosted" | "synthetic" | "interactive"][],
  keys: string[],
): ScriptBuilder {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(seed));
  b.at(0);
  for (const [agentId, kind] of agents)
    b.emit({
      type: "AgentEnrolled",
      entity: { kind: "agent", id: agentId },
      payload: { agentId, projectId: "prj_1", name: agentId, kind, scopes: ["agent:work"] },
    });
  for (const key of keys)
    b.emit({
      type: "SubjectMinted",
      entity: { kind: "subject", id: `sub_${key}` },
      payload: { subjectId: `sub_${key}`, key, anchors: [], gloss: "", mintedBy: "agent" },
    });
  return b;
}

export function declareChange(
  b: ScriptBuilder,
  id: string,
  agentId: string,
  premises: Premise[],
): void {
  b.after(1).emit({
    type: "IntentDeclared",
    entity: { kind: "change", id },
    payload: {
      changeId: id,
      agentId,
      origin: "agent",
      revision: 1,
      goal: id,
      footprint: [],
      premises,
      leaseId: "l",
    },
  });
}

export function foldedLog(b: ScriptBuilder): World {
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}
