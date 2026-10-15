import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canvasOf } from "../../../src/engine/canvas.ts";
import { growthOf, keptAfresh, seededGrowthOf } from "../../../src/engine/growth.ts";
import { provisionalWorld } from "../../../src/engine/seed.ts";
import { MissionHeader } from "../../../src/views/MissionCanvas.tsx";
import { Hand } from "../../fixtures/pipeline.ts";

/** What a header says, as one line of text. */
const said = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

/** A change as Keel's snapshot gives it, but for its state. */
const summary = (changeId: string, number: number) => ({
  changeId,
  number,
  agentId: "agt_1",
  goal: `goal of ${changeId}`,
  revision: 1,
  declaredAt: "2026-10-15T09:00:00.000Z",
  updatedAt: "2026-10-15T09:00:40.000Z",
});

describe("Mission Control's header", () => {
  it("[mission.header-seeded] while the log is read, gives the snapshot's live changes and landings as the log will, and waits on the log for every other figure", () => {
    // One landed, one waiting on a person's ruling, one whose agent's lease lapsed.
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]);
    hand.at(20).verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_a"]);
    hand.at(21).land("chg_a", "sha_1").advance("grp_1", "sha_1", ["chg_a"], { height: 1 });
    hand.at(30).declare("chg_r").declare("chg_w");
    hand.at(40).park("chg_r", "awaiting-ruling").park("chg_w", "lease-lapsed");
    const seeded = seededGrowthOf(
      provisionalWorld({
        cursor: "20",
        trunk: { head: "sha_1", height: 1 },
        changes: [
          { ...summary("chg_w", 3), state: "parked", parkReason: "lease-lapsed" },
          { ...summary("chg_r", 2), state: "parked", parkReason: "awaiting-ruling" },
          { ...summary("chg_a", 1), state: "landed" },
        ],
      }),
      "acme/demo",
    );
    const early = renderToStaticMarkup(
      createElement(MissionHeader, { canvas: null, growth: seeded }),
    );
    expect(said(early)).toBe(
      "Green advances … Caught … Recovered … Landings / min … Agents … · Live 1 · Batches … · Landed 1",
    );
    expect(early).toContain('aria-busy="true"');

    // Once read, the same two figures, and the rest given.
    const now = 60_000;
    const world = hand.world();
    const read = renderToStaticMarkup(
      createElement(MissionHeader, {
        canvas: canvasOf(world, now),
        growth: growthOf(world, now, "acme/demo", keptAfresh()),
      }),
    );
    expect(said(read)).toContain("· Live 1 · Batches 0 · Landed 1");
    expect(said(read)).not.toContain("…");
    expect(read).not.toContain("aria-busy");
  });
});
