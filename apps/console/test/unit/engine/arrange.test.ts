import { describe, expect, it, vi } from "vitest";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import {
  COLUMNS,
  COLUMN_X,
  LANE_GAP,
  NODE_W,
  ROW_H,
  WORLD_W,
  arrange,
  columnOf,
  zoomFor,
} from "../../../src/engine/arrange.ts";
import { lanesOf } from "../../../src/engine/lanes.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

async function lanesAt(scenario: "s1" | "swarm", seconds: number, ruling?: string) {
  const player = showing(
    createMockSource({ scenario, seed: 42, ...(ruling === undefined ? {} : { ruling }) }),
  );
  await player.load();
  player.seek(seconds * 1000);
  return lanesOf(player.world, player.t);
}

describe("where things stand in Mission Control", () => {
  it("gives each kind of thing one column, whatever else is in its lane", () => {
    expect(COLUMNS).toEqual(["Agent", "Change", "Subject", "Conflict", "Probe", "Outcome"]);
    expect(
      (
        [
          "agent",
          "change",
          "stack",
          "reference",
          "subject",
          "conflict",
          "probe",
          "escalation",
          "decision",
          "guard",
        ] as const
      ).map((kind) => `${kind} ${COLUMNS[columnOf(kind)] ?? ""}`),
    ).toEqual([
      "agent Agent",
      "change Change",
      "stack Change",
      "reference Change",
      "subject Subject",
      "conflict Conflict",
      "probe Probe",
      "escalation Outcome",
      "decision Outcome",
      "guard Outcome",
    ]);
  });

  it("places every node of an open lane in its kind's column, inside the lane's own band", async () => {
    for (const lanes of [
      await lanesAt("s1", 460, "live"),
      await lanesAt("s1", 760),
      await lanesAt("swarm", 100),
    ]) {
      const { placed, bands } = arrange(lanes.lanes);
      expect(placed.map((item) => item.node.id).toSorted()).toEqual(
        lanes.lanes.flatMap((lane) => lane.nodes.map((node) => node.id)).toSorted(),
      );
      for (const item of placed) {
        const band = bands.find((each) => each.key === item.lane);
        expect(item.x).toBe(COLUMN_X[columnOf(item.node.kind)]);
        expect(item.width).toBe(NODE_W);
        expect(
          band !== undefined &&
            item.y >= band.top &&
            item.y + item.height <= band.top + band.height,
        ).toBe(true);
      }
      // Two things in one column of one lane stand one above the other, never on top of each other.
      for (const a of placed) {
        for (const b of placed) {
          if (a === b || a.lane !== b.lane || a.x !== b.x) continue;
          expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
        }
      }
    }
  });

  it("stacks the lanes in their order, a closed lane as one row, and is as tall as all of them", async () => {
    const lanes = await lanesAt("swarm", 100);
    const { bands, height } = arrange(lanes.lanes);
    expect(bands.map((band) => band.key)).toEqual(lanes.lanes.map((lane) => lane.key));
    bands.forEach((band, index) => {
      const before = bands[index - 1];
      expect(band.top).toBe(before === undefined ? 0 : before.top + before.height + LANE_GAP);
    });
    expect(bands.some((band) => !band.open)).toBe(true);
    expect([...new Set(bands.filter((band) => !band.open).map((band) => band.height))]).toEqual([
      ROW_H,
    ]);
    const last = bands.at(-1);
    expect(height).toBe((last?.top ?? 0) + (last?.height ?? 0));
    expect(arrange([])).toEqual({ placed: [], bands: [], height: 0 });
  });

  it("is drawn at one size for a window's width, never under four fifths of life size", () => {
    expect(zoomFor(1920)).toBe(1);
    expect(zoomFor(WORLD_W + 400)).toBe(1);
    expect(zoomFor(1500)).toBeGreaterThanOrEqual(0.8);
    expect(zoomFor(1500)).toBeLessThan(1);
    expect(zoomFor(900)).toBe(0.8);
  });
});
