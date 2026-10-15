import { describe, expect, it } from "vitest";
import { changesOf, openCounts, waitsOnARuling } from "../../../src/engine/lists.ts";
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

const LAPSED = "chg_0000000000000000000LAPSED";
const RULING = "chg_0000000000000000000RULING";

/** Two parked changes as keel/keel's log has them: one whose agent's lease lapsed, one waiting on a ruling. */
function parkedTwoWays(): World {
  const b = new ScriptBuilder("2026-10-15T02:00:00.000Z", createRng(7));
  for (const changeId of [LAPSED, RULING])
    b.at(1).emit({
      type: "IntentDeclared",
      entity: { kind: "change", id: changeId },
      payload: {
        changeId,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal: changeId,
        footprint: [],
        premises: [],
        leaseId: "l",
      },
    });
  b.at(2).emit({
    type: "ChangeParked",
    entity: { kind: "change", id: LAPSED },
    payload: { changeId: LAPSED, reason: "lease-lapsed" },
  });
  b.at(3).emit({
    type: "ChangeParked",
    entity: { kind: "change", id: RULING },
    payload: { changeId: RULING, reason: "awaiting-ruling" },
  });
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

describe("a parked change", () => {
  it("[parked.reason] waits on a ruling only where Keel parked it for one: a lapsed lease waits on its agent", () => {
    const world = parkedTwoWays();
    const lapsed = world.changes.get(LAPSED);
    const ruling = world.changes.get(RULING);
    expect(lapsed !== undefined && waitsOnARuling(lapsed)).toBe(false);
    expect(ruling !== undefined && waitsOnARuling(ruling)).toBe(true);
    // The ruling filter lists the one a person is asked about; both are still open.
    expect(changesOf(world, "parked").rows.map((row) => row.id)).toEqual([RULING]);
    expect(
      changesOf(world, "open")
        .rows.map((row) => row.id)
        .toSorted(),
    ).toEqual([LAPSED, RULING].toSorted());
    expect(openCounts(world).changes).toBe(2);
    expect(changesOf(world, "open").rows.find((row) => row.id === LAPSED)?.parkedOn).toBe(
      "lease-lapsed",
    );
    expect(changePageOf(world, LAPSED, NO_RESOURCES)?.parkedOn).toBe("lease-lapsed");
    expect(changePageOf(world, RULING, NO_RESOURCES)?.parkedOn).toBe("awaiting-ruling");
  });
});
