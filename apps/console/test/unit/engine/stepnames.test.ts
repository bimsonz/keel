import { describe, expect, it } from "vitest";
import { changePageOf } from "../../../src/engine/select.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";

const NO_RESOURCES = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

describe("a guard's check on a change's page", () => {
  it("[select.guard-step-name] is named by the guard's label, not Keel's id for its step", async () => {
    const player = showing(createMockSource({ scenario: "s2", seed: 42 }));
    await player.load();
    player.seek(200_000);
    const { world } = player;
    const [guard] = [...world.guards.values()];
    const [change] = [...world.changes.values()];
    expect(guard).toBeDefined();
    expect(change).toBeDefined();
    if (guard === undefined || change === undefined) return;
    const page = changePageOf(world, change.id, NO_RESOURCES);
    expect(page?.stepNames[`guard:${guard.id}`]).toBe(`Guard ${guard.label}`);
    expect(guard.label).toMatch(/^G-\d+$/);
  });
});
