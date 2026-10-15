import { describe, expect, it } from "vitest";
import type { FlowBatch, FlowChange } from "../../../src/engine/flow.ts";
import type { World } from "../../../src/engine/world.ts";
import { Hand, LANE } from "../../fixtures/pipeline.ts";

const changeIn = (world: World, id: string): FlowChange | undefined => world.flow.changes.get(id);
const batchIn = (world: World, id: string): FlowBatch | undefined => world.flow.batches.get(id);

describe("where each change stands in Keel's flow", () => {
  it("[flow.stage] a change moves to the stage Keel's event puts it in, and is left there by an event that names no stage", () => {
    const world = new Hand()
      .at(1)
      .declare("chg_declared")
      .start("chg_declared")
      .declare("chg_checked")
      .start("chg_checked")
      .submit("chg_checked")
      .precheck("chg_checked")
      .declare("chg_rebased")
      .start("chg_rebased")
      .rebase("chg_rebased", "sha_a", "sha_b")
      .queued([
        "chg_queued",
        "chg_parked",
        "chg_requeued",
        "chg_batched",
        "chg_bounced",
        "chg_landed",
        "chg_withdrawn",
        "chg_superseded",
      ])
      .at(2)
      .form("bat_1", ["chg_requeued", "chg_batched", "chg_landed"])
      .at(3)
      .park("chg_parked", "lease-lapsed")
      .requeue("chg_requeued", "bat_1", "co-member-failed")
      .bounce("chg_bounced", ["the build broke"], { verdictId: "vrd_1" })
      .land("chg_landed", "sha_t1")
      .withdraw("chg_withdrawn")
      .supersede("chg_superseded", "chg_landed")
      .world();
    expect(
      Object.fromEntries([...world.flow.changes.values()].map((entry) => [entry.id, entry.stage])),
    ).toEqual({
      chg_declared: "declared",
      chg_checked: "precheck",
      chg_rebased: "precheck",
      chg_queued: "queue",
      chg_parked: "queue",
      chg_requeued: "queue",
      chg_batched: "batch",
      chg_bounced: "bounced",
      chg_landed: "landed",
      chg_withdrawn: "gone",
      chg_superseded: "gone",
    });
  });

  it("[flow.move] keeps where a change came from, when it came, and how many moves it made, and not a stage it was already in", () => {
    const hand = new Hand()
      .at(1)
      .declare("chg_1")
      .start("chg_1")
      .at(5)
      .submit("chg_1")
      .at(6)
      .precheck("chg_1")
      .derive("chg_1")
      .at(9)
      .queue("chg_1")
      .at(12)
      .queue("chg_late");
    // Declared, and its workspace made: one stage, so no move yet.
    expect(changeIn(hand.world(1), "chg_1")).toMatchObject({
      stage: "declared",
      since: 1000,
      moves: 0,
    });
    expect(changeIn(hand.world(1), "chg_1")).not.toHaveProperty("from");
    // Its precheck starting and its effects derived keep it where its submission put it, since then.
    expect(changeIn(hand.world(7), "chg_1")).toMatchObject({
      stage: "precheck",
      from: "declared",
      since: 5000,
      moves: 1,
    });
    const world = hand.world();
    expect(changeIn(world, "chg_1")).toMatchObject({
      stage: "queue",
      from: "precheck",
      since: 9000,
      moves: 2,
    });
    // One the log names first in the queue (a log read from its middle) is drawn there, unmoved.
    expect(changeIn(world, "chg_late")).toMatchObject({ stage: "queue", since: 12_000, moves: 0 });
    expect(changeIn(world, "chg_late")).not.toHaveProperty("from");
  });

  it("[flow.requeue] keeps why Keel queued a change again while it stays in the queue, and drops it when it leaves", () => {
    const hand = new Hand()
      .at(1)
      .queued(["chg_1"])
      .at(2)
      .form("bat_1", ["chg_1"])
      .at(3)
      .requeue("chg_1", "bat_1", "invalidated")
      .at(4)
      .queue("chg_1")
      .at(5)
      .form("bat_2", ["chg_1"]);
    expect(changeIn(hand.world(3), "chg_1")).toMatchObject({
      stage: "queue",
      from: "batch",
      requeued: "invalidated",
    });
    expect(changeIn(hand.world(4), "chg_1")).toMatchObject({
      stage: "queue",
      requeued: "invalidated",
    });
    expect(changeIn(hand.world(5), "chg_1")?.stage).toBe("batch");
    expect(changeIn(hand.world(5), "chg_1")).not.toHaveProperty("requeued");
  });

  it("[flow.parked] holds a park where Keel put it, with its question, until Keel's next event of the change", () => {
    const hand = new Hand()
      .at(1)
      .declare("chg_held")
      .start("chg_held")
      .at(2)
      .submit("chg_held")
      .precheck("chg_held")
      .at(3)
      .park("chg_held", "awaiting-ruling", "esc_1")
      .at(4)
      .resume("chg_held")
      .at(1)
      .queued(["chg_lapsed"])
      .at(3)
      .park("chg_lapsed", "lease-lapsed")
      .at(5)
      .form("bat_1", ["chg_lapsed"]);
    const parked = hand.world(3);
    // A park moves nothing: the change stays in its stage, since it came there.
    expect(changeIn(parked, "chg_held")).toMatchObject({
      stage: "precheck",
      since: 2000,
      moves: 1,
      parked: { reason: "awaiting-ruling", escalationId: "esc_1" },
    });
    expect(changeIn(parked, "chg_lapsed")?.parked).toStrictEqual({ reason: "lease-lapsed" });
    // Resumed, it is still at its precheck, and no longer parked.
    const resumed = hand.world();
    expect(changeIn(resumed, "chg_held")).toMatchObject({
      stage: "precheck",
      since: 2000,
      moves: 1,
    });
    expect(changeIn(resumed, "chg_held")).not.toHaveProperty("parked");
    expect(changeIn(resumed, "chg_lapsed")?.stage).toBe("batch");
    expect(changeIn(resumed, "chg_lapsed")).not.toHaveProperty("parked");
  });

  it("[flow.base] takes a change's base from its workspace, then its submission where it says one, then its rebase", () => {
    const world = new Hand()
      .at(1)
      .declare("chg_started")
      .start("chg_started", "sha_a")
      .submit("chg_started")
      .declare("chg_submitted")
      .start("chg_submitted", "sha_a")
      .submit("chg_submitted", 1, "sha_b")
      .declare("chg_rebased")
      .start("chg_rebased", "sha_a")
      .submit("chg_rebased", 1, "sha_b")
      .precheck("chg_rebased")
      .rebase("chg_rebased", "sha_b", "sha_c")
      .declare("chg_unsaid")
      .start("chg_unsaid")
      .submit("chg_unsaid")
      .world();
    expect(changeIn(world, "chg_started")?.base).toBe("sha_a");
    expect(changeIn(world, "chg_submitted")?.base).toBe("sha_b");
    expect(changeIn(world, "chg_rebased")?.base).toBe("sha_c");
    expect(changeIn(world, "chg_unsaid")).not.toHaveProperty("base");
  });

  it("[flow.paths] draws a change's footprint until Keel says which paths its diff touched, and those from then on", () => {
    const world = new Hand()
      .at(1)
      .declare("chg_declared", { paths: ["src/a.ts", "src/b.ts"] })
      .declare("chg_revised", { paths: ["src/a.ts"] })
      .revise("chg_revised", 2, ["src/a.ts", "src/b.ts", "src/c.ts"])
      .revise("chg_revised", 3)
      .declare("chg_touched", { paths: ["src/a.ts", "src/b.ts"] })
      .submit("chg_touched")
      .derive("chg_touched", ["src/a.ts", "src/d.ts"])
      .revise("chg_touched", 2, ["src/e.ts"])
      .declare("chg_unsaid", { paths: ["src/a.ts"] })
      .submit("chg_unsaid")
      .derive("chg_unsaid")
      .world();
    expect(changeIn(world, "chg_declared")).toMatchObject({
      paths: ["src/a.ts", "src/b.ts"],
      touched: false,
    });
    // A revision without a footprint leaves the last one.
    expect(changeIn(world, "chg_revised")?.paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    // Once its diff is read, a later footprint is only what the agent says it will touch.
    expect(changeIn(world, "chg_touched")).toMatchObject({
      paths: ["src/a.ts", "src/d.ts"],
      touched: true,
    });
    expect(changeIn(world, "chg_unsaid")).toMatchObject({ paths: ["src/a.ts"], touched: false });
  });
});

describe("the batches Keel forms, and how each ended", () => {
  it("[flow.batch] keeps a batch as Keel formed it, its candidate's tier and when its verification started", () => {
    const world = new Hand()
      .at(1)
      .queued(["chg_1", "chg_2"])
      .at(2)
      .form("bat_1", ["chg_1"])
      .at(3)
      .form("bat_2", ["chg_2"], {
        predecessors: ["chg_1"],
        attempt: 2,
        chainEpoch: 3,
        base: "sha_b",
      })
      .at(4)
      .assemble("bat_2", 2, "mergebox")
      .at(6)
      .verifying("bat_2")
      .world();
    expect(batchIn(world, "bat_2")).toStrictEqual({
      id: "bat_2",
      laneId: LANE,
      members: ["chg_2"],
      base: "sha_b",
      predecessors: ["chg_1"],
      attempt: 2,
      chainEpoch: 3,
      formedT: 3000,
      assembled: { t: 4000, tier: 2, composer: "mergebox" },
      verifyingT: 6000,
      steps: [],
    });
    expect(batchIn(world, "bat_1")).toMatchObject({ predecessors: [], formedT: 2000 });
    expect(batchIn(world, "bat_1")).not.toHaveProperty("ended");
  });

  it("[flow.steps] keeps a batch's steps in the order Keel started them, each once, with what each came to, and none of a conflict's worlds", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]);
    hand
      .at(12)
      .verifying("bat_1")
      .stepStarted("bat_1", "keel.check")
      .stepStarted("bat_1", "keel.test");
    hand.at(13).stepStarted("bat_1", "keel.check").stepStarted("bat_1", "js-ts.suite", "AB");
    hand.at(20).stepFinished("bat_1", "keel.test", "abstain", 0, { failure: "timeout" });
    hand.stepFinished("bat_1", "js-ts.suite", "fail", 9, { world: "AB" });
    expect(batchIn(hand.world(), "bat_1")?.steps).toEqual([
      { id: "keel.check", startedT: 12_000 },
      {
        id: "keel.test",
        startedT: 12_000,
        finished: { t: 20_000, outcome: "abstain", durationMs: 0, failure: "timeout" },
      },
    ]);
  });

  it("[flow.batch-end] ends a batch by the event that ended it, with what that event says", () => {
    const world = new Hand()
      .at(1)
      .queued(["chg_1", "chg_2", "chg_3", "chg_4", "chg_5", "chg_6", "chg_7"])
      .at(2)
      .form("bat_green", ["chg_1"])
      .form("bat_red", ["chg_2"])
      .form("bat_split", ["chg_3", "chg_4"])
      .form("bat_stale", ["chg_5"])
      .form("bat_refused", ["chg_6"])
      .form("bat_passed", ["chg_7"])
      .at(5)
      .verified("bat_green")
      .failed("bat_red", "chg_2")
      .bisected("bat_split", ["bat_left", "bat_right"])
      .invalidated("bat_stale")
      .verified("bat_refused")
      .verified("bat_passed")
      .at(8)
      .declined("bat_refused", "pack-too-large")
      .promoted("bat_passed")
      .world();
    expect(batchIn(world, "bat_green")?.ended).toStrictEqual({
      t: 5000,
      how: "green",
      verdictId: "vrd_bat_green",
    });
    expect(batchIn(world, "bat_red")?.ended).toStrictEqual({
      t: 5000,
      how: "red",
      verdictId: "vrd_bat_red",
      attribution: "chg_2",
    });
    expect(batchIn(world, "bat_split")?.ended).toStrictEqual({
      t: 5000,
      how: "bisected",
      into: ["bat_left", "bat_right"],
    });
    expect(batchIn(world, "bat_stale")?.ended).toStrictEqual({
      t: 5000,
      how: "invalidated",
      reason: "head-moved",
    });
    expect(batchIn(world, "bat_refused")?.ended).toStrictEqual({
      t: 8000,
      how: "declined",
      reason: "pack-too-large",
    });
    // Passed and being put on trunk: still the verdict that passed it, and when it did.
    expect(batchIn(world, "bat_passed")?.ended).toStrictEqual({
      t: 5000,
      how: "promoted",
      verdictId: "vrd_bat_passed",
    });
  });

  it("[flow.landed] lands the batches of a promotion when trunk advances by it, and no other", () => {
    const hand = new Hand()
      .at(1)
      .queued(["chg_1", "chg_2", "chg_3", "chg_4"])
      .at(2)
      .form("bat_1", ["chg_1"])
      .form("bat_2", ["chg_2"], { predecessors: ["chg_1"] })
      .form("bat_3", ["chg_3"])
      .form("bat_4", ["chg_4"])
      .at(3)
      .verified("bat_1")
      .verified("bat_2")
      .verified("bat_3")
      .verified("bat_4")
      .at(4)
      .promoted("bat_1")
      .promoted("bat_2")
      .at(5)
      .promoting("grp_1", ["bat_1", "bat_2"], ["chg_1", "chg_2"])
      .promoting("grp_2", ["bat_4"], ["chg_4"])
      .at(6)
      .advance("grp_1", "sha_t1", ["chg_1", "chg_2"], { height: 1 })
      .at(7)
      .declined("bat_4", "commutation-failed");
    const promoting = hand.world(5);
    expect([...promoting.flow.promoting.keys()]).toEqual(["grp_1", "grp_2"]);
    expect(promoting.flow.promoting.get("grp_1")).toEqual({
      batches: ["bat_1", "bat_2"],
      members: ["chg_1", "chg_2"],
      t: 5000,
    });
    expect(batchIn(promoting, "bat_1")?.ended?.how).toBe("promoted");

    const world = hand.world();
    for (const id of ["bat_1", "bat_2"])
      expect(batchIn(world, id)?.ended).toStrictEqual({
        t: 6000,
        how: "landed",
        verdictId: `vrd_${id}`,
      });
    expect(batchIn(world, "bat_3")?.ended).toMatchObject({ t: 3000, how: "green" });
    expect(batchIn(world, "bat_4")?.ended).toMatchObject({ t: 7000, how: "declined" });
    // Trunk advanced by the one, and Keel declined the other: neither is still being put on trunk.
    expect(world.flow.promoting.size).toBe(0);
  });
});

describe("trunk's advances", () => {
  it("[flow.commits] keeps trunk's advances newest first, at Keel's height or the one after the last, and which were verified", () => {
    const world = new Hand()
      .at(1)
      .advance("grp_1", "sha_1", ["chg_a"], { height: 7 })
      .at(2)
      .advance("grp_2", "sha_2", ["chg_b", "chg_c"])
      .at(3)
      .advance("grp_3", "sha_3", ["chg_d"], { height: 12, verified: false })
      .at(4)
      .advance("grp_4", "sha_4", ["chg_e"], { verified: true })
      .world();
    expect(world.flow.commits).toStrictEqual([
      { height: 13, sha: "sha_4", t: 4000, changes: ["chg_e"], verified: true },
      { height: 12, sha: "sha_3", t: 3000, changes: ["chg_d"], verified: false },
      { height: 8, sha: "sha_2", t: 2000, changes: ["chg_b", "chg_c"], verified: true },
      { height: 7, sha: "sha_1", t: 1000, changes: ["chg_a"], verified: true },
    ]);
  });

  it("[flow.landed-in] names the commit that carried each change, and keeps when each landing was", () => {
    const world = new Hand()
      .at(1)
      .queued(["chg_1", "chg_2", "chg_3"])
      .at(2)
      .form("bat_1", ["chg_1", "chg_2"])
      .verified("bat_1")
      .promoting("grp_1", ["bat_1"], ["chg_1", "chg_2"])
      .at(3)
      .land("chg_1", "sha_t1")
      .land("chg_2", "sha_t1")
      .advance("grp_1", "sha_t1", ["chg_1", "chg_2"], { height: 1 })
      .at(5)
      .form("bat_2", ["chg_3"])
      .verified("bat_2")
      .promoting("grp_2", ["bat_2"], ["chg_3"])
      .at(6)
      .land("chg_3", "sha_t2")
      .advance("grp_2", "sha_t2", ["chg_3"], { height: 2 })
      .world();
    expect(changeIn(world, "chg_1")).toMatchObject({ stage: "landed", landedIn: "sha_t1" });
    expect(changeIn(world, "chg_2")).toMatchObject({ stage: "landed", landedIn: "sha_t1" });
    expect(changeIn(world, "chg_3")).toMatchObject({ stage: "landed", landedIn: "sha_t2" });
    // Three landings in two advances.
    expect(world.flow.landings).toEqual([3000, 3000, 6000]);
  });
});
