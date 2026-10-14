// Scenarios 3 and 4: what a proof does to a change.
//
// Both open as scenario 1 does, up to the proof: #2 relies on freshness being
// at most per-request, #1 makes it per-session without saying so, and probe
// P-1 proves the conflict between them. What follows turns on the predicate
// policy each change's plan compiled, which Keel applies on the change itself
// the moment it hears the proof.
//
//   Scenario 3, advise   The plans say nothing of freshness, which is advise.
//                        Keel notes the conflict on both changes and holds
//                        neither. #1 goes on to land as it was written. #2 is
//                        still being verified when the story ends.
//   Scenario 4, block    The plans block on freshness. Both changes bounce on
//                        the conflict itself, and no verdict is issued for
//                        either: the proof is the cause.
//
// The conflict is left proven in both. Nobody is asked, and nobody resolves it.

import type { EntityRef } from "../../../src/contract/envelope.ts";
import type { NextAction } from "../../../src/contract/events.ts";
import { createRng } from "../prng.ts";
import { LANDED_B_AS_WRITTEN } from "../repo.ts";
import { type GeneratedLog, ScriptBuilder } from "./builder.ts";
import { HEAD_1, type Opening, S1_EPOCH, land, opening } from "./s1.ts";

const changeRef = (id: string): EntityRef => ({ kind: "change", id });

/** The ways forward Keel names to a change a conflict was proven against: read it, revise around it, resolve it. */
export function conflictActions(changeId: string, conflictId: string): NextAction[] {
  return [
    {
      kind: "read",
      title: "Read the conflict and the proof against the change",
      operationId: "Conflicts_getConflict",
      args: { conflictId },
    },
    {
      kind: "call",
      title: "Revise the change's intent around the conflict",
      operationId: "revise",
      args: { changeId },
    },
    {
      kind: "call",
      title: "Resolve the conflict with a move",
      operationId: "resolve",
      args: { conflictId },
    },
  ];
}

/** Each side's Change DO hears the proof in turn: the side whose effect was derived first, then the premise's holder. */
const heard = (o: Opening): [number, string][] => [
  [447.4, o.changeB],
  [447.5, o.changeA],
];

export function generateS3(seed: number): GeneratedLog {
  const b = new ScriptBuilder(S1_EPOCH, createRng(seed).fork("s3"));
  const o = opening(b);
  for (const [second, change] of heard(o)) {
    b.at(second).emit({
      type: "ConflictNoted",
      entity: changeRef(change),
      payload: {
        changeId: change,
        conflictId: o.conflict,
        predicate: "freshness",
        policy: "advise",
        evidenceRef: `probe:${o.probe}`,
        nextActions: conflictActions(change, o.conflict),
      },
      causation: o.proven,
    });
  }
  // Nothing holds #1. It goes through its lane and onto trunk as it was written, cache and all.
  land(b, o, {
    at: 449,
    change: o.changeB,
    workspace: o.workspaceB,
    agent: o.agentB,
    from: o.head0,
    to: HEAD_1,
    height: 1,
    label: "L1·1",
    landing: LANDED_B_AS_WRITTEN,
  });
  return b.build();
}

export function generateS4(seed: number): GeneratedLog {
  const b = new ScriptBuilder(S1_EPOCH, createRng(seed).fork("s4"));
  const o = opening(b, { freshness: "block" });
  for (const [second, change] of heard(o)) {
    b.at(second).emit({
      type: "ChangeBounced",
      entity: changeRef(change),
      payload: {
        changeId: change,
        conflictId: o.conflict,
        reasons: [`Proven against this change, whose plan blocks on its predicate: ${o.conflict}.`],
        nextActions: conflictActions(change, o.conflict),
      },
      causation: o.proven,
    });
  }
  return b.build();
}
