import { describe, expect, it } from "vitest";
import { canvasOf } from "../../../src/engine/canvas.ts";
import { type ConsoleSource, Player } from "../../../src/engine/player.ts";
import { trunkStatsOf } from "../../../src/engine/select.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";

/**
 * Scenario 1, ruled, read as a live Keel's log is, up to and including its first landing when `cut`. The wall
 * clock is `clock.sinceTheLogBegan`, in ms, and is the test's to move.
 */
async function live(clock: { sinceTheLogBegan: number }, cut = false): Promise<Player> {
  const told = createMockSource({ scenario: "s1", seed: 42, ruling: "invalidate" });
  const all = (await told.readEvents({ limit: 500 })).items;
  const events = cut
    ? all.slice(0, all.findIndex((event) => event.type === "ChangeLanded") + 1)
    : all;
  const source: ConsoleSource = {
    ...told,
    descriptor: { ...told.descriptor, mode: "live" },
    readEvents: (request = {}) =>
      Promise.resolve({ items: request.cursor === undefined ? events : [], nextCursor: "end" }),
    readObservations: () => Promise.resolve({ items: [], nextCursor: "end" }),
  };
  const epoch = Date.parse(source.descriptor.epoch ?? "");
  const player = new Player(source, () => epoch + clock.sinceTheLogBegan);
  player.scopeTo("demo");
  await player.load();
  player.seek(player.end);
  player.play();
  return player;
}

/** Mission Control's canvas as it stands at the player's now. */
const canvasNow = (player: Player) => canvasOf(player.world, player.t);
/** The changes trunk's commits on the canvas carried. */
const carried = (player: Player): string[] =>
  canvasNow(player).commits.flatMap((commit) => commit.changes.map((change) => change.label));
const quiet = (player: Player): string[] =>
  canvasNow(player).changes.flatMap((change) => (change.quiet ? [change.label] : []));

describe("a live console's clock", () => {
  it("[clock.live] follows the wall clock when Keel's log is quiet, so what finished is seen to have", async () => {
    const clock = { sinceTheLogBegan: 0 };
    const player = await live(clock, true);
    const landed = player.end;
    // The moment it lands, the change is drawn on the commit that carried it, and counted in the rate of landings.
    clock.sinceTheLogBegan = landed + 1_000;
    player.tick(16);
    expect(player.t).toBe(landed + 1_000);
    expect(carried(player)).toEqual(["#2"]);
    expect(trunkStatsOf(player.world, player.t).landedPerMinute).toBe(1);
    expect(canvasNow(player).answers.perMinute).toBe(0.1);
    // Keel writes nothing more. Two minutes on, nothing has landed in the last minute.
    clock.sinceTheLogBegan = landed + 120_000;
    player.tick(16);
    expect(trunkStatsOf(player.world, player.t).landedPerMinute).toBe(0);
    // Eleven minutes on, nothing has landed in Mission Control's last ten, and the change left behind is not quiet yet.
    clock.sinceTheLogBegan = landed + 11 * 60_000;
    player.tick(16);
    expect(canvasNow(player).answers.perMinute).toBe(0);
    expect(quiet(player)).toEqual([]);
    // Half an hour on, it has not moved for half an hour, and is drawn quiet.
    clock.sinceTheLogBegan = landed + 31 * 60_000;
    player.tick(16);
    expect(quiet(player)).toEqual(["#1"]);
  });

  it("[clock.skew] is never behind the log's own end, whatever this machine's clock says", async () => {
    const clock = { sinceTheLogBegan: -3_600_000 };
    const player = await live(clock);
    player.tick(16);
    expect(player.t).toBe(player.end);
    // A replay's clock is its own: the wall clock is not read at all.
    const told = createMockSource({ scenario: "s1", seed: 42, ruling: "invalidate" });
    const replay = new Player(told, () => {
      throw new Error("a replay read the wall clock");
    });
    replay.scopeTo("demo");
    await replay.load();
    replay.seek(100_000);
    replay.play();
    replay.tick(250);
    expect(replay.t).toBe(100_000 + 250 * replay.rate);
  });
});
