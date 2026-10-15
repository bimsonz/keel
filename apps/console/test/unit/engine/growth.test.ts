import { describe, expect, it } from "vitest";
import {
  type AgentNode,
  type BatchNode,
  type CheckNode,
  DISSOLVE_MS,
  FORK_SLOTS,
  type ForkNode,
  type Growth,
  type GrowthNode,
  type PileNode,
  RING,
  SETTLED_MS,
  growthOf,
  keptAfresh,
  seededGrowthOf,
} from "../../../src/engine/growth.ts";
import { canvasOf } from "../../../src/engine/canvas.ts";
import type { ChangeSummary, FeedSnapshot } from "../../../src/contract/keel/index.ts";
import { provisionalWorld } from "../../../src/engine/seed.ts";
import { Hand } from "../../fixtures/pipeline.ts";

const forkOf = (growth: Growth, id: string): ForkNode | undefined =>
  growth.nodes.find((node): node is ForkNode => node.kind === "fork" && node.changeId === id);

const batchOf = (growth: Growth, id: string): BatchNode | undefined =>
  growth.nodes.find((node): node is BatchNode => node.kind === "batch" && node.batchId === id);

const checksOf = (growth: Growth, batchId: string): CheckNode[] =>
  growth.nodes.filter(
    (node): node is CheckNode => node.kind === "check" && node.id.startsWith(`check:${batchId}:`),
  );

const edge = (growth: Growth, kind: string, source: string, target: string) =>
  growth.edges.find(
    (each) => each.kind === kind && each.source === source && each.target === target,
  );

const centre = (node: GrowthNode) => ({ x: node.x + node.w / 2, y: node.y + node.h / 2 });
/** How far out from the project a node is, in rings: its distance with the rings' stretch taken out. */
const out = (node: GrowthNode) => {
  const { x, y } = centre(node);
  return Math.hypot(x / 1.8, y);
};
const angle = (node: GrowthNode) => Math.atan2(centre(node).y, centre(node).x / 1.8);
const overlap = (a: GrowthNode, b: GrowthNode) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the project in the centre", () => {
  it("[growth.centre] draws the project at the centre, named, with trunk's head, whether Keel verified it, and its live and landed counts", () => {
    const hand = new Hand().queued(["chg_a", "chg_b"]).at(10).form("bat_1", ["chg_a"]);
    hand.at(20).verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_a"]);
    hand.at(21).land("chg_a", "sha_1").advance("grp_1", "sha_1", ["chg_a"], { height: 7 });
    const growth = growthOf(hand.world(), 30_000, "keel/forge", keptAfresh());
    const project = growth.nodes.find((node) => node.kind === "project");
    expect(project).toMatchObject({
      id: "project",
      name: "keel/forge",
      head: { height: 7, sha: "sha_1", verified: true },
      live: 1,
      landed: 1,
    });
    expect(centre(project!)).toEqual({ x: 0, y: 0 });
  });
});

describe("a fork for each change, with its agent", () => {
  it("[growth.runs] counts the runs the drawn changes name, each once, so one account's many runs read as many agents", () => {
    const hand = new Hand()
      .runOf("agt_1", { id: "run_1", label: "a" })
      .declare("chg_a")
      .declare("chg_b");
    hand.runOf("agt_1", { id: "run_2", label: "b" }).declare("chg_c");
    expect(growthOf(hand.world(), 1000, "p", keptAfresh()).runs).toBe(2);
  });

  it("[growth.fork] puts a declared change on the fork ring with an edge out to it from the project, and its agent beside it, named, with its run, joined to it", () => {
    const hand = new Hand()
      .enrol("agt_1", "Ada")
      .runOf("agt_1", { id: "run_1", label: "nightly" })
      .declare("chg_a", { label: "#1" });
    const growth = growthOf(hand.world(), 1000, "p", keptAfresh());
    const fork = forkOf(growth, "chg_a");
    expect(fork).toMatchObject({ label: "#1", goal: "goal of chg_a", stage: "declared", fade: 1 });
    expect(out(fork!)).toBeCloseTo(RING.fork, 0);
    expect(edge(growth, "fork", "project", fork!.id)).toBeDefined();
    const agent = growth.nodes.find((node): node is AgentNode => node.kind === "agent");
    expect(agent).toMatchObject({ agentId: "agt_1", name: "Ada", run: "nightly" });
    expect(edge(growth, "works", agent!.id, fork!.id)).toBeDefined();
    expect(overlap(agent!, fork!)).toBe(false);
  });

  it("[growth.standing] tells a fork moving, waiting or stuck: moving at precheck or just moved, waiting once still, stuck once bounced", () => {
    const hand = new Hand()
      .declare("chg_a")
      .declare("chg_b")
      .start("chg_b")
      .submit("chg_b")
      .precheck("chg_b");
    hand.declare("chg_c").start("chg_c").submit("chg_c").precheck("chg_c").queue("chg_c");
    hand.at(5).bounce("chg_c", ["keel.test failed"], { verdictId: "vrd_x" });
    const growth = growthOf(hand.world(), 600_000, "p", keptAfresh());
    expect(forkOf(growth, "chg_a")?.standing).toBe("waiting");
    expect(forkOf(growth, "chg_b")?.standing).toBe("moving");
    expect(forkOf(growth, "chg_c")).toMatchObject({ standing: "stuck", why: "keel.test failed" });
    expect(forkOf(growthOf(hand.world(), 1000, "p", keptAfresh()), "chg_a")?.standing).toBe(
      "moving",
    );
  });

  it("[growth.escalated] marks a fork parked on a question put to a person, and no fork parked for another reason", () => {
    const hand = new Hand().queued(["chg_a", "chg_b"]);
    hand.park("chg_a", "awaiting-ruling", "esc_1").park("chg_b", "lease-lapsed");
    const growth = growthOf(hand.world(), 1_000, "p", keptAfresh());
    expect(forkOf(growth, "chg_a")?.escalated).toBe(true);
    expect(forkOf(growth, "chg_b")?.escalated).toBeUndefined();
  });

  it("[growth.kept] never moves a fork once placed, as others are declared, land and dissolve; forks declared one after another sit side by side", () => {
    const kept = keptAfresh();
    const hand = new Hand().queued(["chg_a", "chg_b"]);
    const first = growthOf(hand.world(), 1000, "p", kept);
    const [a, b] = [forkOf(first, "chg_a")!, forkOf(first, "chg_b")!];
    hand.at(10).declare("chg_c").form("bat_1", ["chg_a"]);
    hand.at(20).verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_a"]);
    hand.at(21).land("chg_a", "sha_1").advance("grp_1", "sha_1", ["chg_a"]);
    const later = growthOf(hand.world(), 25_000, "p", kept);
    expect(forkOf(later, "chg_b")).toMatchObject({ x: b.x, y: b.y });
    expect(forkOf(later, "chg_a")).toMatchObject({ x: a.x, y: a.y });
    const gone = growthOf(hand.world(), 21_000 + DISSOLVE_MS + 1000, "p", kept);
    expect(forkOf(gone, "chg_b")).toMatchObject({ x: b.x, y: b.y });
    expect(forkOf(gone, "chg_c")).toMatchObject(forkOf(later, "chg_c")!);
    // Side by side: the angle between the first two is one place's.
    expect(Math.abs(angle(b) - angle(a))).toBeCloseTo((2 * Math.PI) / FORK_SLOTS, 5);
  });
});

describe("forks joining a batch, and its checks", () => {
  it("[growth.join] joins the forks Keel batched into one batch further out, between them", () => {
    const hand = new Hand()
      .queued(["chg_a", "chg_b", "chg_c"])
      .at(10)
      .form("bat_1", ["chg_a", "chg_b"]);
    const growth = growthOf(hand.world(), 11_000, "p", keptAfresh());
    const batch = batchOf(growth, "bat_1")!;
    expect(batch).toMatchObject({ state: "forming", members: 2 });
    expect(out(batch)).toBeCloseTo(RING.batch, 0);
    expect(edge(growth, "join", "fork:chg_a", batch.id)?.moving).toBe(true);
    expect(edge(growth, "join", "fork:chg_b", batch.id)).toBeDefined();
    expect(edge(growth, "join", "fork:chg_c", batch.id)).toBeUndefined();
    const [a, b] = [forkOf(growth, "chg_a")!, forkOf(growth, "chg_b")!];
    const middle = Math.atan2(centre(batch).y, centre(batch).x / 1.8);
    const between = Math.atan2(
      (centre(a).y + centre(b).y) / 2,
      (centre(a).x + centre(b).x) / 1.8 / 2,
    );
    expect(Math.abs(middle - between)).toBeLessThan((2 * Math.PI) / 28);
  });

  it("[growth.chain] rests each batch formed on others in flight on the last of them alone, so a run of batches is one line", () => {
    const hand = new Hand()
      .queued(["chg_a", "chg_b", "chg_c", "chg_d"])
      .at(10)
      .form("bat_1", ["chg_a"])
      .at(11)
      .form("bat_2", ["chg_b"], { predecessors: ["chg_a"] })
      .at(12)
      .form("bat_3", ["chg_c"], { predecessors: ["chg_a", "chg_b"] })
      .at(13)
      .form("bat_4", ["chg_d"]);
    const growth = growthOf(hand.world(), 14_000, "p", keptAfresh());
    const chains = growth.edges
      .filter((each) => each.kind === "chain")
      .map((each) => `${each.source} > ${each.target}`)
      .toSorted();
    expect(chains).toEqual(["batch:bat_2 > batch:bat_1", "batch:bat_3 > batch:bat_2"]);
  });

  it("[growth.checks] runs one check with its timer while the batch verifies, then draws each step the verdict names with what it came to, further out", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]).assemble("bat_1", 2);
    hand.at(12).verifying("bat_1");
    const running = checksOf(growthOf(hand.world(), 30_000, "p", keptAfresh()), "bat_1");
    expect(running).toMatchObject([{ name: "Checks", result: "running", since: 12_000 }]);
    hand
      .at(40)
      .verdict("vrd_bat_1", "bat_1", [
        "keel.check: pass (proof, tier 2: …) evidence sha256:1",
        "keel.test: fail (proof, tier 2: …) evidence sha256:2",
      ]);
    hand.failed("bat_1", "chg_a");
    const growth = growthOf(hand.world(), 41_000, "p", keptAfresh());
    const checks = checksOf(growth, "bat_1");
    expect(checks.map((check) => [check.name, check.result])).toEqual([
      ["keel.check", "pass"],
      ["keel.test", "fail"],
    ]);
    for (const check of checks) {
      expect(out(check)).toBeCloseTo(RING.check, 0);
      expect(edge(growth, "test", "batch:bat_1", check.id)?.moving).toBe(false);
    }
    expect(overlap(checks[0]!, checks[1]!)).toBe(false);
  });

  it("[growth.steps] draws each step Keel started, running with its timer from its start, then what it came to and how long the runner took, in place of the one running check", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]).assemble("bat_1", 2);
    hand.at(12).verifying("bat_1").at(13).stepStarted("bat_1", "keel.check");
    hand.at(15).stepStarted("bat_1", "keel.test");
    const running = checksOf(growthOf(hand.world(), 30_000, "p", keptAfresh()), "bat_1");
    expect(running.map((check) => [check.name, check.result, check.since])).toEqual([
      ["keel.check", "running", 13_000],
      ["keel.test", "running", 15_000],
    ]);
    hand.at(20).stepFinished("bat_1", "keel.check", "pass", 6_400);
    const growth = growthOf(hand.world(), 30_000, "p", keptAfresh());
    const checks = checksOf(growth, "bat_1");
    expect(checks).toMatchObject([
      { name: "keel.check", result: "pass", took: 6_400 },
      { name: "keel.test", result: "running", since: 15_000 },
    ]);
    expect(edge(growth, "test", "batch:bat_1", "check:bat_1:keel.check")?.moving).toBe(false);
    expect(edge(growth, "test", "batch:bat_1", "check:bat_1:keel.test")?.moving).toBe(true);
  });

  it("[growth.steps-stopped] draws a step still running when its batch ended as stopped, in the words of that end", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]).assemble("bat_1", 2);
    hand
      .at(12)
      .verifying("bat_1")
      .stepStarted("bat_1", "keel.check")
      .stepStarted("bat_1", "keel.test");
    hand.at(20).stepFinished("bat_1", "keel.check", "fail", 7_000);
    hand.at(21).failed("bat_1", "chg_a");
    const growth = growthOf(hand.world(), 22_000, "p", keptAfresh());
    const why = batchOf(growth, "bat_1")?.why;
    expect(why).toBeDefined();
    expect(checksOf(growth, "bat_1")).toMatchObject([
      { name: "keel.check", result: "fail", took: 7_000 },
      { name: "keel.test", result: "stopped", line: why },
    ]);
  });

  it("[growth.steps-verdict] gives a started step the verdict's line for it, and draws from the verdict a step it names that never started", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]).assemble("bat_1", 2);
    hand.at(12).verifying("bat_1").stepStarted("bat_1", "keel.check");
    hand.at(20).stepFinished("bat_1", "keel.check", "pass", 5_000);
    hand
      .at(40)
      .verdict("vrd_bat_1", "bat_1", [
        "keel.check: pass (proof, tier 2: …) evidence sha256:1",
        "keel.test: fail (proof, tier 2: …) evidence sha256:2",
      ]);
    hand.failed("bat_1", "chg_a");
    const checks = checksOf(growthOf(hand.world(), 41_000, "p", keptAfresh()), "bat_1");
    expect(checks).toMatchObject([
      {
        name: "keel.check",
        result: "pass",
        line: "keel.check: pass (proof, tier 2: …) evidence sha256:1",
      },
      {
        name: "keel.test",
        result: "fail",
        line: "keel.test: fail (proof, tier 2: …) evidence sha256:2",
      },
    ]);
  });

  it("[growth.composed] draws a verdict that names no step, as when Keel could not compose the batch, as one failed check in Keel's words", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]);
    hand
      .at(20)
      .verdict("vrd_bat_1", "bat_1", [
        "composition-refused: conflict src/a.ts",
        "conflicts with chg_z, landed as f02e89f2, on src/a.ts",
      ]);
    hand.failed("bat_1", "chg_a").bounce("chg_a", ["conflict"], { verdictId: "vrd_bat_1" });
    const checks = checksOf(growthOf(hand.world(), 21_000, "p", keptAfresh()), "bat_1");
    expect(checks).toMatchObject([
      {
        name: "composition-refused",
        result: "fail",
        line: "composition-refused: conflict src/a.ts\nconflicts with chg_z, landed as f02e89f2, on src/a.ts",
      },
    ]);
  });
});

const landed = () => {
  const hand = new Hand().queued(["chg_a", "chg_b"]).at(10).form("bat_1", ["chg_a"]);
  hand.at(20).verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_a"]);
  hand.at(30).land("chg_a", "sha_1").advance("grp_1", "sha_1", ["chg_a"]);
  return hand;
};

describe("landing, and the branch dissolving", () => {
  it("[growth.land] runs the landing back into the project, then fades the fork, its agent, its batch and its edges out, and draws none of them once dissolved", () => {
    const hand = landed();
    const now = growthOf(hand.world(), 30_000, "p", keptAfresh());
    expect(edge(now, "land", "batch:bat_1", "project")?.moving).toBe(true);
    const half = growthOf(hand.world(), 30_000 + DISSOLVE_MS / 2, "p", keptAfresh());
    expect(forkOf(half, "chg_a")?.fade).toBeCloseTo(0.5, 2);
    expect(batchOf(half, "bat_1")?.fade).toBeCloseTo(0.5, 2);
    expect(
      half.nodes.find((node) => node.kind === "agent" && node.id.startsWith("agent:chg_a:"))?.fade,
    ).toBeCloseTo(0.5, 2);
    expect(edge(half, "land", "batch:bat_1", "project")?.fade).toBeCloseTo(0.5, 2);
    const gone = growthOf(hand.world(), 30_000 + DISSOLVE_MS + 1, "p", keptAfresh());
    expect(forkOf(gone, "chg_a")).toBeUndefined();
    expect(batchOf(gone, "bat_1")).toBeUndefined();
    expect(gone.nodes.some((node) => node.id.startsWith("agent:chg_a:"))).toBe(false);
    expect(forkOf(gone, "chg_b")?.fade).toBe(1);
  });

  it("[growth.deploy] puts a preview Keel deployed after the checks, and lands from it", () => {
    const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]);
    hand.at(12).verifying("bat_1");
    hand.b.emit({
      type: "PreviewDeployed",
      entity: { kind: "change", id: "chg_a" },
      payload: {
        deploymentId: "dpl_1",
        changeId: "chg_a",
        candidateId: "cnd_bat_1",
        world: "candidate",
        target: "production",
        provider: "cloudflare",
        url: "https://3f2a-forge.example.workers.dev",
      },
    });
    hand
      .at(20)
      .verdict("vrd_bat_1", "bat_1", ["keel.test: pass (proof, tier 2: …) evidence sha256:2"]);
    hand.verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_a"]);
    hand.at(30).land("chg_a", "sha_1").advance("grp_1", "sha_1", ["chg_a"]);
    const growth = growthOf(hand.world(), 30_000, "p", keptAfresh());
    const deploy = growth.nodes.find((node) => node.kind === "deploy");
    expect(deploy).toMatchObject({ url: "https://3f2a-forge.example.workers.dev", down: false });
    expect(out(deploy!)).toBeCloseTo(RING.deploy, 0);
    expect(edge(growth, "ship", "check:bat_1:keel.test", deploy!.id)).toBeDefined();
    expect(edge(growth, "land", deploy!.id, "project")).toBeDefined();
    expect(edge(growth, "land", "batch:bat_1", "project")).toBeUndefined();
  });
});

const bounced = () => {
  const hand = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]);
  hand
    .at(20)
    .verdict("vrd_bat_1", "bat_1", [
      "keel.check: pass (proof, tier 2: …) evidence sha256:1",
      "keel.test: fail (proof, tier 2: …) evidence sha256:2",
    ]);
  hand.failed("bat_1", "chg_a").bounce("chg_a", ["keel.test failed"], { verdictId: "vrd_bat_1" });
  return hand;
};

describe("a bounce", () => {
  it("[growth.bounce] runs red from the check that failed back to the fork and to its agent, and keeps the branch past a landing's time", () => {
    const hand = bounced();
    const growth = growthOf(hand.world(), 20_000 + DISSOLVE_MS * 4, "p", keptAfresh());
    const agent = growth.nodes.find((node) => node.kind === "agent")!;
    expect(edge(growth, "fail", "check:bat_1:keel.test", "fork:chg_a")?.moving).toBe(true);
    expect(edge(growth, "fail", "check:bat_1:keel.test", agent.id)).toBeDefined();
    expect(edge(growth, "fail", "check:bat_1:keel.check", "fork:chg_a")).toBeUndefined();
    expect(forkOf(growth, "chg_a")).toMatchObject({ stage: "bounced", fade: 1 });
    expect(batchOf(growth, "bat_1")?.state).toBe("red");
  });

  it("[growth.fit-failed] fits the view to a failed batch's checks, so the bounce's arc starts inside the frame", () => {
    const growth = growthOf(bounced().world(), 20_000 + DISSOLVE_MS * 4, "p", keptAfresh());
    const { focus } = growth;
    const checks = checksOf(growth, "bat_1");
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check.x).toBeGreaterThanOrEqual(focus.x);
      expect(check.y).toBeGreaterThanOrEqual(focus.y);
      expect(check.x + check.w).toBeLessThanOrEqual(focus.x + focus.width);
      expect(check.y + check.h).toBeLessThanOrEqual(focus.y + focus.height);
    }
  });

  it("[growth.settled] counts a bounce left unrevised past SETTLED_MS in the bounced pile, and draws neither its batch nor its checks", () => {
    const hand = bounced();
    const kept = keptAfresh();
    expect(forkOf(growthOf(hand.world(), 30_000, "p", kept), "chg_a")).toBeDefined();
    const growth = growthOf(hand.world(), 20_000 + SETTLED_MS + 1000, "p", kept);
    expect(forkOf(growth, "chg_a")).toBeUndefined();
    expect(growth.nodes.find((node) => node.kind === "pile")).toMatchObject({
      stage: "bounced",
      count: 1,
    });
    expect(batchOf(growth, "bat_1")).toBeUndefined();
    expect(checksOf(growth, "bat_1")).toEqual([]);
    expect(growth.edges.some((each) => each.kind === "fail")).toBe(false);
  });

  it("[growth.revised] lets the bounce go once the change is revised: no red edge, no failed batch", () => {
    const hand = bounced();
    hand.at(40).revise("chg_a", 2);
    const growth = growthOf(hand.world(), 41_000, "p", keptAfresh());
    expect(growth.edges.some((each) => each.kind === "fail")).toBe(false);
    expect(batchOf(growth, "bat_1")).toBeUndefined();
    expect(forkOf(growth, "chg_a")?.stage).toBe("declared");
  });
});

describe("at scale", () => {
  it("[growth.pile] past the fork ring's places, piles the forks that only wait by stage with their counts, and gives a stuck or batched one a place first", () => {
    const many = Array.from(
      { length: FORK_SLOTS + 5 },
      (_, index) => `chg_${String(index).padStart(2, "0")}`,
    );
    const hand = new Hand().queued(many);
    const last = many.at(-1)!;
    hand.at(10).form("bat_1", [last]);
    hand.declare("chg_new");
    const growth = growthOf(hand.world(), 11_000, "p", keptAfresh());
    const forks = growth.nodes.filter((node) => node.kind === "fork");
    expect(forks).toHaveLength(FORK_SLOTS);
    expect(forkOf(growth, last)).toBeDefined();
    const piles = growth.nodes.filter((node): node is PileNode => node.kind === "pile");
    expect(
      piles
        .toSorted((a, b) => a.stage.localeCompare(b.stage))
        .map((pile) => [pile.stage, pile.count]),
    ).toEqual([
      ["declared", 1],
      ["queue", 5],
    ]);
    for (const pile of piles) expect(edge(growth, "fork", "project", pile.id)).toBeDefined();
  });

  it("[growth.bounds] holds every node in its bounds, and no two cards on the fork ring overlap one another or the project", () => {
    const many = Array.from({ length: FORK_SLOTS }, (_, index) => `chg_${index}`);
    const growth = growthOf(new Hand().queued(many).world(), 1000, "p", keptAfresh());
    const { x, y, width, height } = growth.bounds;
    for (const node of growth.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(x);
      expect(node.y).toBeGreaterThanOrEqual(y);
      expect(node.x + node.w).toBeLessThanOrEqual(x + width);
      expect(node.y + node.h).toBeLessThanOrEqual(y + height);
    }
    for (const node of growth.nodes.filter(
      (each) => each.kind !== "check" && each.kind !== "deploy",
    )) {
      expect(node.x).toBeGreaterThanOrEqual(growth.focus.x);
      expect(node.x + node.w).toBeLessThanOrEqual(growth.focus.x + growth.focus.width);
    }
    const cards = growth.nodes.filter((node) => node.kind !== "pile");
    for (const [index, a] of cards.entries())
      for (const b of cards.slice(index + 1))
        expect(overlap(a, b), `${a.id} and ${b.id}`).toBe(false);
  });
});

describe("a change waiting on its agent", () => {
  it("[growth.lapsed] draws a change whose agent's lease lapsed as waiting on its agent, grey and not live, and one parked on a question as stuck", () => {
    const hand = new Hand().declare("chg_gone").declare("chg_asks").declare("chg_busy");
    hand.at(5).park("chg_gone", "lease-lapsed").park("chg_asks", "awaiting-ruling");
    // Hours on: a lapsed change is on nobody's clock of Keel's.
    const growth = growthOf(hand.world(), 3 * 60 * 60 * 1000, "keel/swarm", keptAfresh());
    expect(forkOf(growth, "chg_gone")).toMatchObject({
      standing: "waiting",
      idle: true,
      why: "Waiting on its agent: its lease lapsed",
    });
    expect(forkOf(growth, "chg_asks")).toMatchObject({
      standing: "stuck",
      why: "Waiting on a person's ruling",
    });
    expect(forkOf(growth, "chg_asks")?.idle).toBeUndefined();
    // Live is what Keel is moving or asking about: the change waiting on its agent is not among it.
    expect(growth.nodes.find((node) => node.kind === "project")).toMatchObject({ live: 2 });
    const canvas = canvasOf(hand.world(), 3 * 60 * 60 * 1000);
    expect(canvas.live).toBe(2);
    // The agent holds all three, and two of them are live.
    expect(canvas.agents.map((agent) => [agent.changes, agent.live])).toEqual([[3, 2]]);
  });
});

/** A change as Keel's snapshot of the log's head gives it. */
const summary = (
  changeId: string,
  number: number,
  state: ChangeSummary["state"],
  parkReason?: ChangeSummary["parkReason"],
): ChangeSummary => ({
  changeId,
  number,
  state,
  ...(parkReason === undefined ? {} : { parkReason }),
  agentId: "agt_1",
  goal: `goal of ${changeId}`,
  revision: 1,
  declaredAt: "2026-10-15T09:00:00.000Z",
  updatedAt: "2026-10-15T09:01:00.000Z",
});

const projectNode = (growth: Growth) => growth.nodes.find((node) => node.kind === "project");

describe("the diagram while the log is read", () => {
  it("[growth.seeded] draws the project from Keel's snapshot as the read log draws it, with no fork, its view fitted where the forks will stand", () => {
    // keel/swarm's shape: two landed; many whose agent's lease lapsed, three of them bounced long since; two
    // parked on a person's ruling; one withdrawn.
    const hand = new Hand().queued(["chg_l1", "chg_l2"]).at(10).form("bat_1", ["chg_l1", "chg_l2"]);
    hand.at(20).verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_l1", "chg_l2"]);
    hand.at(21).land("chg_l1", "sha_2").land("chg_l2", "sha_2");
    hand.advance("grp_1", "sha_2", ["chg_l1", "chg_l2"], { height: 2 });
    const lapsed = Array.from({ length: 18 }, (_, n) => `chg_w${n}`);
    const bouncedLong = ["chg_b1", "chg_b2", "chg_b3"];
    hand.at(30);
    for (const id of [...lapsed, ...bouncedLong, "chg_r1", "chg_r2", "chg_x"]) hand.declare(id);
    hand.at(40);
    for (const id of bouncedLong) hand.bounce(id, ["the build failed"], { verdictId: "vrd_b" });
    hand.at(50).withdraw("chg_x");
    hand.at(60);
    for (const id of [...lapsed, ...bouncedLong]) hand.park(id, "lease-lapsed");
    hand.park("chg_r1", "awaiting-ruling").park("chg_r2", "awaiting-ruling");
    // The same project, as Keel's snapshot of the log's head gives it, newest first.
    const snapshot: FeedSnapshot = {
      cursor: "99",
      trunk: { head: "sha_2", height: 2 },
      changes: [
        summary("chg_l1", 1, "landed"),
        summary("chg_l2", 2, "landed"),
        ...[...lapsed, ...bouncedLong].map((id, n) => summary(id, 3 + n, "parked", "lease-lapsed")),
        summary("chg_r1", 24, "parked", "awaiting-ruling"),
        summary("chg_r2", 25, "parked", "awaiting-ruling"),
        summary("chg_x", 26, "withdrawn"),
      ].toReversed(),
    };
    const read = growthOf(hand.world(), 3 * 60 * 60 * 1000, "keel/swarm", keptAfresh());
    const seeded = seededGrowthOf(provisionalWorld(snapshot), "keel/swarm");

    // The log, once read: trunk's head verified, the two on a ruling live, and every fork's place taken.
    expect(projectNode(read)).toMatchObject({
      head: { height: 2, sha: "sha_2", verified: true },
      live: 2,
      landed: 2,
    });
    expect(read.nodes.filter((node) => node.kind === "fork")).toHaveLength(FORK_SLOTS);
    // The snapshot draws the same project, but for whether trunk's head was verified, which only the log says.
    const { head: _verified, ...same } = projectNode(read)!;
    expect(projectNode(seeded)).toEqual({ ...same, head: { height: 2, sha: "sha_2" } });
    // And nothing else until the log is read: no fork, pile or line, so nothing drawn early moves or retimes.
    expect(seeded.nodes.map((node) => node.kind)).toEqual(["project"]);
    expect(seeded.edges).toEqual([]);
    // The view is fitted where the forks stand once the log is read, so it does not move when they come.
    expect(seeded.focus).toEqual(read.focus);

    // A project with no change standing, as keel/keel: the project alone, fitted as the read log fits it.
    const quiet = new Hand().queued(["chg_a"]).at(10).form("bat_1", ["chg_a"]);
    quiet.at(20).verified("bat_1").promoting("grp_1", ["bat_1"], ["chg_a"]);
    quiet.at(21).land("chg_a", "sha_1").advance("grp_1", "sha_1", ["chg_a"], { height: 1 });
    const quietRead = growthOf(quiet.world(), 3 * 60 * 60 * 1000, "keel/keel", keptAfresh());
    const quietSeeded = seededGrowthOf(
      provisionalWorld({
        cursor: "9",
        trunk: { head: "sha_1", height: 1 },
        changes: [summary("chg_a", 1, "landed")],
      }),
      "keel/keel",
    );
    expect(quietSeeded.focus).toEqual(quietRead.focus);
    expect(projectNode(quietSeeded)).toMatchObject({ live: 0, landed: 1 });
  });
});
