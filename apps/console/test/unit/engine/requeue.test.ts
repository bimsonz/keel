import { describe, expect, it } from "vitest";
import { changePageOf } from "../../../src/engine/select.ts";
import { World } from "../../../src/engine/world.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createRng } from "../../fixtures/prng.ts";

const NO_RESOURCES = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

const CHANGE = "chg_00000000000000000REQUEUED";
const BATCH = "bat_00000000000000000000000001";

/** A change Keel batches, then puts back in its queue twice: once for an infrastructure failure, once to bisect. */
function requeuedTwice(): World {
  const b = new ScriptBuilder("2026-10-15T01:00:00.000Z", createRng(5));
  b.at(1).emit({
    type: "IntentDeclared",
    entity: { kind: "change", id: CHANGE },
    payload: {
      changeId: CHANGE,
      agentId: "agt_1",
      origin: "agent",
      revision: 1,
      goal: "a change Keel queues again",
      footprint: [],
      premises: [],
      leaseId: "l",
    },
  });
  b.emit({
    type: "ChangeSubmitted",
    entity: { kind: "change", id: CHANGE },
    payload: { changeId: CHANGE, revision: 1, commitSha: "0a1b2c3", workspaceId: "wsp_1" },
  });
  b.at(2).emit({
    type: "ChangeRequeued",
    entity: { kind: "change", id: CHANGE },
    payload: { changeId: CHANGE, batchId: BATCH, reason: "infra-failure" },
  });
  b.at(3).emit({
    type: "ChangeRequeued",
    entity: { kind: "change", id: CHANGE },
    payload: { changeId: CHANGE, batchId: BATCH, reason: "bisection" },
  });
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

describe("a change Keel puts back in its queue", () => {
  it("[requeue.reason] shows Keel's latest reason, when it gave it, and how many times it has", () => {
    const world = requeuedTwice();
    const page = changePageOf(world, CHANGE, NO_RESOURCES);
    expect(page?.change.state).toBe("queued");
    expect(page?.requeued?.reason).toBe("bisection");
    expect(page?.requeued?.times).toBe(2);
    expect(page?.requeued?.at).toMatch(/^2026-10-15T01:00:03/);
  });
});
