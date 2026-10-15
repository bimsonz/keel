import { describe, expect, it } from "vitest";
import {
  type Canvas,
  type CanvasBatch,
  type CanvasChange,
  CHIP_STAGES,
  COLUMN_DENSE_AT,
  COMMITS_SHOWN,
  DENSE_AT,
  HUES,
  LINGER_MS,
  QUIET_MS,
  answersOf,
  canvasOf,
  hueOf,
  stepsOf,
} from "../../../src/engine/canvas.ts";
import { Hand } from "../../fixtures/pipeline.ts";

const ids = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, index) => `${prefix}_${index + 1}`);

const chipOf = (canvas: Canvas, id: string): CanvasChange | undefined =>
  canvas.changes.find((each) => each.id === id);

const batchOf = (batches: readonly CanvasBatch[], id: string): CanvasBatch | undefined =>
  batches.find((batch) => batch.id === id);

describe("a verdict's evidence, read as the steps of a plan", () => {
  it("[canvas.steps] reads each step's name, result and tier from Keel's line, the later of two lines for one step, and keeps any other line as said", () => {
    const lines = [
      "keel.check: fail (proof, tier 2: the build broke) evidence sha256:aa11",
      "keel.lint: pass (static, tier 0) evidence sha256:bb22",
      "suite:unit: pass evidence sha256:cc33",
      "keel.e2e: abstain (no browser in the box) evidence sha256:dd44",
      "the plan ran four steps",
      "keel.check: pass (proof, tier 1: rerun) evidence sha256:ee55",
    ];
    expect(stepsOf(lines)).toStrictEqual([
      { name: "keel.check", result: "pass", tier: 1, line: lines[5] },
      { name: "keel.lint", result: "pass", tier: 0, line: lines[1] },
      { name: "suite:unit", result: "pass", line: lines[2] },
      { name: "keel.e2e", result: "abstain", line: lines[3] },
      { name: "the plan ran four steps", result: "said", line: lines[4] },
    ]);
  });
});

describe("an agent's colour", () => {
  it("[canvas.hue] is the same for the same id on every reading, and one of the hues there are", () => {
    // Pinned: a colour that moved between releases would tell one agent apart from itself.
    expect(["agt_1", "agt_ada", "run_7"].map(hueOf)).toEqual([3, 4, 0]);
    const agents = Array.from({ length: 256 }, (_, n) => `agt_${n.toString(36)}`);
    const hues = agents.map(hueOf);
    expect(agents.map(hueOf)).toEqual(hues);
    expect(hues.filter((hue) => !Number.isInteger(hue) || hue < 0 || hue >= HUES)).toEqual([]);
    expect(new Set(hues).size).toBe(HUES);
  });
});

describe("the answers the header gives", () => {
  it("[canvas.unverified] never counts green an advance Keel took with verification off, nor one an audit found red", () => {
    const world = new Hand()
      .at(1)
      .advance("grp_1", "sha_1", ["chg_1"], { height: 1 })
      .advance("grp_2", "sha_2", ["chg_2"], { height: 2, verified: false })
      .advance("grp_3", "sha_3", ["chg_3"], { height: 3 })
      .advance("grp_4", "sha_4", ["chg_4"], { height: 4, verified: false })
      .advance("grp_5", "sha_5", ["chg_5"], { height: 5 })
      .advance("grp_6", "sha_6", ["chg_6"], { height: 6, verified: true })
      .at(2)
      .audit("sha_3", "red")
      .audit("sha_5", "green")
      .world();
    // Six advances: two unverified, one red, three green.
    expect(answersOf(world, 2000)).toMatchObject({ advances: 6, unverified: 2, green: 3 });
  });

  it("[canvas.caught] counts the conflicts Keel proved and the batches it failed on a clash between members, and nothing else it failed", () => {
    const hand = new Hand().at(1).queued(ids("chg", 9)).proven("cfl_1", ["chg_1", "chg_2"]).at(2);
    // Two failed on a textual clash, three on an interaction, four on the infrastructure.
    const blamed = ["textual", "textual", "interaction", "interaction", "interaction"];
    const failures = [...blamed, "infra", "infra", "infra", "infra"];
    failures.forEach((attribution, index) => {
      hand.form(`bat_${index + 1}`, [`chg_${index + 1}`]).failed(`bat_${index + 1}`, attribution);
    });
    expect(answersOf(hand.world(), 3000).caught).toBe(6);
  });

  it("[canvas.recovered] counts each change bounced by a verdict or a conflict once, and those that went on to land", () => {
    const world = new Hand()
      .at(1)
      .queued(["chg_back", "chg_out_1", "chg_out_2", "chg_clean"])
      .at(2)
      .bounce("chg_back", ["the build broke"], { verdictId: "vrd_1" })
      .bounce("chg_back", ["the build broke again"], { verdictId: "vrd_2" })
      .bounce("chg_out_1", ["a proven conflict"], { conflictId: "cfl_1" })
      .bounce("chg_out_2", ["a proven conflict"], { conflictId: "cfl_1" })
      .at(3)
      .land("chg_back", "sha_t1")
      .land("chg_clean", "sha_t1")
      .world();
    expect(answersOf(world, 3000)).toMatchObject({ bounced: 3, recovered: 1 });
  });

  it("[canvas.rate] gives the landings a minute over the last ten minutes", () => {
    const world = new Hand()
      .at(100)
      .advance("grp_1", "sha_1", ["chg_1", "chg_2"], { height: 1 })
      .at(700)
      .advance("grp_2", "sha_2", ["chg_3"], { height: 2 })
      .at(900)
      .advance("grp_3", "sha_3", ["chg_4", "chg_5"], { height: 3 })
      .world();
    expect(answersOf(world, 1_000_000).perMinute).toBeCloseTo(0.3, 9);
    expect(answersOf(world, 600_000).perMinute).toBeCloseTo(0.2, 9);
    // Ten minutes after a landing, it is no longer in the span.
    expect(answersOf(world, 700_000).perMinute).toBeCloseTo(0.1, 9);
  });
});

describe("the changes on the canvas", () => {
  it("[canvas.chips] draws a chip for each live change in the stage Keel put it in, and none for one landed or gone", () => {
    const bounced = ids("chg_bounced", 1);
    const declared = ids("chg_declared", 2);
    const prechecked = ids("chg_precheck", 3);
    const queued = ids("chg_queue", 4);
    const batched = ids("chg_batch", 5);
    const hand = new Hand().at(1);
    for (const id of declared) hand.declare(id).start(id);
    for (const id of prechecked) hand.declare(id).start(id).submit(id).precheck(id);
    hand.queued([...bounced, ...queued, ...batched, "chg_landed", "chg_gone", "chg_replaced"]);
    hand
      .at(2)
      .form("bat_1", batched)
      .bounce("chg_bounced_1", ["the build broke"], { verdictId: "vrd_1" })
      .land("chg_landed", "sha_t1")
      .withdraw("chg_gone")
      .supersede("chg_replaced", "chg_landed");
    const canvas = canvasOf(hand.world(), 3000);
    expect(canvas.counts).toMatchObject({
      bounced: 1,
      declared: 2,
      precheck: 3,
      queue: 4,
      batches: 1,
    });
    expect(canvas.live).toBe(15);
    expect(canvas.changes.map((chip) => chip.id).toSorted()).toEqual(
      [...bounced, ...declared, ...prechecked, ...queued, ...batched].toSorted(),
    );
    const inBatch = canvas.changes.filter((chip) => chip.stage === "batch");
    expect(inBatch.map((chip) => chip.batchId)).toEqual(batched.map(() => "bat_1"));
    expect(
      canvas.changes.filter((chip) => chip.stage !== "batch" && chip.batchId !== undefined),
    ).toEqual([]);
  });

  it("[canvas.chip] carries what Keel said of a change: its run's colour, why it was requeued, parked or bounced, and whether it has gone quiet", () => {
    const hand = new Hand()
      .at(1)
      .runOf("agt_r", { id: "run_7", label: "night" })
      .declare("chg_run", { agentId: "agt_r", label: "#1" })
      .declare("chg_bare", { agentId: "agt_b", label: "#2" })
      .queued(["chg_bounced", "chg_requeued", "chg_parked"])
      .at(2)
      .form("bat_1", ["chg_requeued"])
      .bounce("chg_bounced", ["the build broke", "a test failed"], { verdictId: "vrd_1" })
      .park("chg_parked", "awaiting-ruling", "esc_1")
      .at(3)
      .requeue("chg_requeued", "bat_1", "bisection");
    const world = hand.world();
    const canvas = canvasOf(world, 3000);
    expect(chipOf(canvas, "chg_run")).toMatchObject({
      label: "#1",
      goal: "goal of chg_run",
      agentId: "agt_r",
      runId: "run_7",
      hue: hueOf("run_7"),
    });
    expect(chipOf(canvas, "chg_bare")).toMatchObject({ agentId: "agt_b", hue: hueOf("agt_b") });
    expect(chipOf(canvas, "chg_bare")).not.toHaveProperty("runId");
    expect(chipOf(canvas, "chg_bounced")).toMatchObject({
      stage: "bounced",
      bounced: "the build broke",
    });
    expect(chipOf(canvas, "chg_requeued")).toMatchObject({ stage: "queue", requeued: "bisection" });
    expect(chipOf(canvas, "chg_requeued")).not.toHaveProperty("batchId");
    expect(chipOf(canvas, "chg_parked")).toMatchObject({
      stage: "queue",
      parked: { reason: "awaiting-ruling", escalationId: "esc_1" },
    });
    // Quiet once it has stood still for longer than QUIET_MS.
    expect(chipOf(canvasOf(world, 1000 + QUIET_MS), "chg_run")?.quiet).toBe(false);
    expect(chipOf(canvasOf(world, 1001 + QUIET_MS), "chg_run")?.quiet).toBe(true);
  });

  it("[canvas.dense] draws a stage as dots past its own threshold, and every stage as dots past the canvas's", () => {
    const columns = new Hand().at(1);
    for (const id of ids("chg_p", COLUMN_DENSE_AT)) columns.declare(id).submit(id);
    columns.queued(ids("chg_q", COLUMN_DENSE_AT + 1));
    const one = canvasOf(columns.world(), 2000);
    expect(one).toMatchObject({ dense: false, dotted: ["queue"] });

    const full = new Hand().at(1);
    for (const id of ids("chg", DENSE_AT)) full.declare(id);
    expect(canvasOf(full.world(), 2000)).toMatchObject({
      live: DENSE_AT,
      dense: false,
      dotted: ["declared"],
    });
    full.declare("chg_more");
    const dense = canvasOf(full.world(), 2000);
    expect(dense).toMatchObject({ live: DENSE_AT + 1, dense: true });
    expect(dense.dotted).toEqual(CHIP_STAGES);
  });
});

describe("the batches on the canvas", () => {
  it("[canvas.chain] draws each batch on the latest-formed batch in flight that holds one of its predecessors, as deep as that chain goes", () => {
    const canvas = canvasOf(
      new Hand()
        .at(1)
        .queued(["chg_1", "chg_2", "chg_3", "chg_4"])
        .at(2)
        .form("bat_1", ["chg_1"])
        .at(3)
        .form("bat_2", ["chg_2"], { predecessors: ["chg_1"] })
        .at(4)
        .form("bat_3", ["chg_3"], { predecessors: ["chg_1", "chg_2"] })
        .at(5)
        .form("bat_4", ["chg_4"], { predecessors: ["chg_1"] })
        .world(),
      6000,
    );
    expect(
      canvas.batches.map((batch) => ({ label: batch.label, depth: batch.depth, on: batch.on })),
    ).toEqual([
      { label: "batch 1", depth: 0, on: undefined },
      { label: "batch 2", depth: 1, on: "batch 1" },
      { label: "batch 3", depth: 2, on: "batch 2" },
      { label: "batch 4", depth: 1, on: "batch 1" },
    ]);
  });

  it("[canvas.batch-state] draws each batch in the state its last event left it, with what Keel blamed or why it stopped", () => {
    const evidence = [
      "keel.check: fail (proof, tier 2: the build broke) evidence sha256:aa11",
      "keel.lint: pass (static, tier 0) evidence sha256:bb22",
    ];
    const world = new Hand()
      .at(1)
      .declare("chg_blamed", { label: "#7" })
      .queued(ids("chg", 9))
      .at(2)
      .form("bat_forming", ["chg_1"])
      .form("bat_assembled", ["chg_2"])
      .form("bat_verifying", ["chg_3"])
      .form("bat_green", ["chg_4"])
      .form("bat_promoting", ["chg_5"])
      .form("bat_red", ["chg_6", "chg_blamed"])
      .form("bat_cancelled", ["chg_7"])
      .form("bat_bisected", ["chg_8"])
      .form("bat_declined", ["chg_9"])
      .at(3)
      .assemble("bat_assembled", 1)
      .assemble("bat_verifying", 2, "mergebox")
      .verifying("bat_verifying")
      .verified("bat_green")
      .verified("bat_promoting")
      .promoted("bat_promoting")
      .verdict("vrd_bat_red", "bat_red", evidence)
      .failed("bat_red", "chg_blamed")
      .invalidated("bat_cancelled")
      .bisected("bat_bisected", ["bat_left", "bat_right"])
      .verified("bat_declined")
      .declined("bat_declined", "pack-too-large")
      .world();
    const canvas = canvasOf(world, 4000);
    expect(Object.fromEntries(canvas.batches.map((batch) => [batch.id, batch.state]))).toEqual({
      bat_forming: "forming",
      bat_assembled: "assembled",
      bat_verifying: "verifying",
      bat_green: "green",
      bat_promoting: "promoting",
      bat_red: "red",
      bat_cancelled: "cancelled",
      bat_bisected: "bisected",
      bat_declined: "declined",
    });
    expect(batchOf(canvas.batches, "bat_verifying")).toMatchObject({
      tier: 2,
      composer: "mergebox",
      verifyingT: 3000,
    });
    expect(batchOf(canvas.batches, "bat_red")).toMatchObject({ why: "#7", endedT: 3000 });
    expect(
      batchOf(canvas.batches, "bat_red")?.steps.map((step) => [step.name, step.result]),
    ).toEqual([
      ["keel.check", "fail"],
      ["keel.lint", "pass"],
    ]);
    expect(batchOf(canvas.batches, "bat_cancelled")?.why).toBe("head-moved");
    expect(batchOf(canvas.batches, "bat_declined")?.why).toBe("pack-too-large");
    expect(canvas.counts).toMatchObject({ batches: 3, verifying: 1 });
  });

  it("[canvas.linger] keeps a batch that ended off trunk for LINGER_MS, a passed one until its changes land, and none trunk took", () => {
    const hand = new Hand()
      .at(1)
      .queued(["chg_red", "chg_green", "chg_landing", "chg_landed"])
      .at(2)
      .form("bat_red", ["chg_red"])
      .form("bat_green", ["chg_green"])
      .form("bat_landing", ["chg_landing"])
      .form("bat_landed", ["chg_landed"])
      .at(10)
      .failed("bat_red", "chg_red")
      .verified("bat_green")
      .verified("bat_landing")
      .verified("bat_landed")
      .promoting("grp_1", ["bat_landed"], ["chg_landed"])
      .at(11)
      .land("chg_landing", "sha_t1")
      .at(12)
      .land("chg_landed", "sha_t2")
      .advance("grp_1", "sha_t2", ["chg_landed"], { height: 2 });
    const drawn = (until: number, now: number): string[] =>
      canvasOf(hand.world(until), now).batches.map((batch) => batch.id);
    expect(drawn(10, 10_000)).toEqual(["bat_red", "bat_green", "bat_landing", "bat_landed"]);
    // Its one change landed: the batch is on trunk, whether or not trunk's advance has come yet.
    expect(drawn(11, 11_000)).toEqual(["bat_red", "bat_green", "bat_landed"]);
    expect(drawn(12, 12_000)).toEqual(["bat_red", "bat_green"]);
    expect(drawn(12, 10_000 + LINGER_MS - 1)).toEqual(["bat_red", "bat_green"]);
    expect(drawn(12, 10_000 + LINGER_MS)).toEqual(["bat_green"]);
    expect(drawn(12, 10_000 + 10 * LINGER_MS)).toEqual(["bat_green"]);
    // A change that landed is not drawn as a chip: it is on trunk.
    expect(canvasOf(hand.world(), 12_000).changes.map((chip) => chip.id)).toEqual([
      "chg_red",
      "chg_green",
    ]);
  });
});

describe("trunk on the canvas", () => {
  it("[canvas.trunk] draws trunk's latest advances, newest first, with the changes each carried", () => {
    const hand = new Hand().at(1).declare("chg_1", { label: "#1" });
    for (let height = 1; height <= COMMITS_SHOWN + 2; height += 1)
      hand.at(height).advance(`grp_${height}`, `sha_${height}`, [`chg_${height}`], { height });
    const canvas = canvasOf(hand.world(), 20_000);
    expect(canvas.commits.map((commit) => commit.height)).toEqual(
      Array.from({ length: COMMITS_SHOWN }, (_, index) => COMMITS_SHOWN + 2 - index),
    );
    expect(canvas.counts.landed).toBe(COMMITS_SHOWN + 2);
    const one = new Hand()
      .at(1)
      .declare("chg_1", { label: "#1" })
      .advance("grp_1", "sha_1", ["chg_1", "chg_unknown"], { height: 1, verified: false });
    // A change this log never declared is named by the end of its id.
    expect(canvasOf(one.world(), 2000).commits).toStrictEqual([
      {
        height: 1,
        sha: "sha_1",
        t: 1000,
        verified: false,
        changes: [
          { id: "chg_1", label: "#1", hue: hueOf("agt_1") },
          { id: "chg_unknown", label: "nown", hue: hueOf("chg_unknown") },
        ],
      },
    ]);
  });
});
