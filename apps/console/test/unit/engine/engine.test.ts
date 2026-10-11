import { describe, expect, it } from "vitest";
import type { Lattice } from "../../../src/contract/keel/index.ts";
import type { MatrixCell } from "../../../src/domain/state.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import type { Player } from "../../../src/engine/player.ts";
import {
  changePageOf,
  choicesOf,
  openEscalations,
  conflictPageOf,
  trunkStatsOf,
} from "../../../src/engine/select.ts";
import { contradictionsOf } from "../../../src/engine/sides.ts";
import { World } from "../../../src/engine/world.ts";
import { showing } from "../showing.ts";

async function playerAt(seconds: number, ruling?: string): Promise<Player> {
  const player = showing(
    createMockSource({ scenario: "s1", seed: 42, ...(ruling === undefined ? {} : { ruling }) }),
  );
  await player.load();
  player.seek(seconds * 1000);
  // Let the resource fetches the seek started settle.
  await Promise.resolve();
  await Promise.resolve();
  return player;
}

function conflictPage(player: Player) {
  const conflict = [...player.world.conflicts.keys()][0] ?? "";
  return conflictPageOf(player.world, conflict, player);
}

function never(): never {
  throw new Error("expected a value");
}

function outcomes(cell: MatrixCell | undefined): string[] {
  if (cell === undefined) return [];
  if (cell.kind === "none") return [];
  return cell.kind === "probe" ? [...cell.runs] : [cell.outcome];
}

describe("the console's picture of scenario 1", () => {
  it("shows no conflict before B's effects are derived", async () => {
    const player = await playerAt(394);
    expect(player.world.conflicts.size).toBe(0);
    expect(player.world.changes.size).toBe(2);
  });

  it("fills the world matrix cell by cell, with the deciding cell last", async () => {
    const state = conflictPage(await playerAt(443));
    expect(state?.conflict).toMatchObject({
      label: "C-1",
      state: "probing",
      silentRetraction: true,
    });
    expect(outcomes(state?.matrix.cells.trunk.probe)).toEqual(["n/a", "n/a", "n/a"]);
    expect(outcomes(state?.matrix.cells.A.probe)).toEqual(["pass", "pass", "pass"]);
    expect(outcomes(state?.matrix.cells.B.probe)).toEqual(["n/a", "n/a", "n/a"]);
    expect(outcomes(state?.matrix.cells.AB["tests-a"])).toEqual(["pass"]);
    expect(outcomes(state?.matrix.cells.AB.probe)).toEqual(["fail", "fail", "running"]);
  });

  it("[matrix.control] has a control row, where the probe must fail and no suite is run or waited for", async () => {
    // The baseline is in and the control's probe has not run yet: that probe is what is running, and not a suite
    // Keel never runs there.
    const before = conflictPage(await playerAt(414.2));
    expect(before?.matrix.cells.trunk.probe).toMatchObject({ runs: ["n/a", "n/a", "n/a"] });
    expect(before?.matrix.cells["A-noop"]).toEqual({
      "tests-a": { kind: "none" },
      "tests-b": { kind: "none" },
      probe: { kind: "probe", runs: ["running", "pending", "pending"], control: true },
    });

    const state = conflictPage(await playerAt(443));
    expect(state?.matrix.worlds.map((world) => world.id)).toEqual([
      "trunk",
      "A-noop",
      "A",
      "B",
      "AB",
    ]);
    // A's world with what A relies on removed: a probe that passed here would prove nothing.
    expect(state?.matrix.cells["A-noop"].probe).toMatchObject({
      kind: "probe",
      runs: ["fail", "fail", "fail"],
      control: true,
    });
    expect(state?.matrix.cells.AB.probe).not.toHaveProperty("control");
    expect(state?.matrix.cells["A-noop"]["tests-a"]).toEqual({ kind: "none" });
    expect(state?.matrix.cells["A-noop"]["tests-b"]).toEqual({ kind: "none" });
    // Each change's own suite, by the change it belongs to.
    expect(state?.matrix.cells.A["tests-a"]).toMatchObject({
      outcome: "pass",
      passed: 31,
      total: 31,
    });
    expect(state?.matrix.cells.A["tests-b"]).toMatchObject({
      outcome: "n/a",
      reason: "B's tests are not in this world",
    });
    expect(state?.matrix.cells.B["tests-b"]).toMatchObject({
      outcome: "pass",
      passed: 27,
      total: 27,
    });
    expect(state?.matrix.cells.AB["tests-b"]).toMatchObject({
      outcome: "pass",
      passed: 27,
      total: 27,
    });
  });

  it("says what an effect contradicts from the conflict Keel opened, and stops saying it once that is settled", async () => {
    const during = await playerAt(460, "live");
    // Keel numbers the changes as they are declared: the one that alters is #1, the one that relies is #2.
    const b = [...during.world.changes.values()].find((change) => change.label === "#1");
    const file = changePageOf(during.world, b?.id ?? "", during);
    expect(file?.derived.map((effect) => [effect.method, effect.against])).toEqual([
      ["extractor", "#2's premise: freshness at most per-request"],
      ["clef", "#2's premise: freshness at most per-request"],
    ]);
    // #2 holds the premise: nothing it derived contradicts anything, and the conflict names #1 as the side that alters.
    const a = [...during.world.changes.values()].find((change) => change.label === "#2");
    expect(contradictionsOf(during.world, a?.id ?? "")).toEqual([]);
    expect(
      contradictionsOf(during.world, b?.id ?? "").map(({ conflict, sides }) => [
        conflict.label,
        sides.holder.label,
        sides.other.label,
      ]),
    ).toEqual([["C-1", "#2", "#1"]]);
    expect(
      changePageOf(during.world, a?.id ?? "", during)?.derived.filter(
        (effect) => effect.against !== undefined,
      ),
    ).toEqual([]);
    const after = await playerAt(9999);
    expect(
      changePageOf(after.world, b?.id ?? "", after)?.derived.filter(
        (effect) => effect.against !== undefined,
      ),
    ).toEqual([]);
  });

  it("names the worlds A and B as Keel does, and says beside each which change it is", async () => {
    const state = conflictPage(await playerAt(443));
    expect(state?.matrix.worlds.map((world) => [world.label, world.gloss])).toEqual([
      ["trunk", "Neither change"],
      ["A-noop", "#2, with what it relies on removed"],
      ["A", "#2 alone"],
      ["B", "#1 alone"],
      ["A+B", "#2 and #1, composed"],
    ]);
    expect(state?.matrix.checks.map((check) => check.label)).toEqual([
      "A's tests",
      "B's tests",
      "Probe P-1",
    ]);
    expect([state?.parties.A.label, state?.parties.B.label]).toEqual(["#2", "#1"]);
  });

  it("reads an agent's class from its kind, and its harness from its session", async () => {
    const player = await playerAt(100);
    // The operator is a person, and never an agent.
    expect(
      [...player.world.agents.values()].map((agent) => [agent.name, agent.class, agent.harness]),
    ).toEqual([
      ["Agent B", "real", "Claude Code"],
      ["Agent A", "real", "Claude Code"],
    ]);
  });

  it("shows what the agent declared its change would do, once it says so, beside what Keel derived", async () => {
    const before = await playerAt(460);
    const b = [...before.world.changes.values()].find((change) => change.label === "#1");
    expect(changePageOf(before.world, b?.id ?? "", before)?.intent.declaredEffects).toEqual([]);
    const after = await playerAt(700, "invalidate");
    expect(changePageOf(after.world, b?.id ?? "", after)?.intent.declaredEffects).toMatchObject([
      {
        subject: "authz.permission-evaluation",
        predicate: "freshness",
        value: "per-session",
        scope: "until revoked",
      },
    ]);
  });

  it("tells a landed change's page from the revision that landed, not from the one that was refused", async () => {
    const player = await playerAt(700, "invalidate");
    const b = [...player.world.changes.values()].find((change) => change.label === "#1");
    const file = changePageOf(player.world, b?.id ?? "", player);
    expect(file?.change).toMatchObject({ state: "landed", revision: 2 });
    // The first revision's silent retraction, and the comparison it failed, are not this revision's.
    expect(file?.drift).toEqual([]);
    expect(file?.plan.steps.map((step) => [step.id, step.outcome])).toEqual([
      ["diff", "pass"],
      ["protected", "pass"],
      ["extract", "pass"],
      ["clef", "annotate"],
      ["lattice", "pass"],
      ["typecheck", "pass"],
      ["unit", "pass"],
      ["guard", "pass"],
    ]);
    // What it landed on is the verdict of the batch that carried it.
    expect(file?.verdict).toMatchObject({
      outcome: "land",
      summary: "Verified: nothing it could have broken is broken",
    });

    // Part-way through the second revision's check, a step it has not reached is still to come: the first
    // revision's failure is not carried over to it.
    const during = await playerAt(642, "invalidate");
    const steps = new Map(
      changePageOf(during.world, b?.id ?? "", during)?.plan.steps.map((step) => [
        step.id,
        step.outcome,
      ]),
    );
    expect([steps.get("diff"), steps.get("lattice")]).toEqual(["pass", "pending"]);
  });

  it("takes short labels and the advance count from Keel, and numbers nothing itself", async () => {
    const player = await playerAt(9999);
    expect([...player.world.conflicts.values()].map((conflict) => conflict.label)).toEqual(["C-1"]);
    // The same log as a Keel that sends no labels would publish it: the console falls back to ids, never to counting.
    const bare = new World();
    const source = createMockSource({ scenario: "s2", seed: 42 });
    const { items } = await source.readEvents({ limit: 500 });
    for (const event of items) {
      const unlabelled = { ...event };
      delete unlabelled.label;
      bare.apply(unlabelled, 0);
    }
    expect(
      [...bare.conflicts.values()]
        .map((conflict) => conflict.label)
        .every((label) => label.startsWith("C·")),
    ).toBe(true);
    // A change with no number from Keel is named by part of its id, never by a number of the console's.
    expect(bare.changes.size).toBe(4);
    for (const change of bare.changes.values()) expect(change.label).toBe(change.id.slice(-4));
    expect(
      [...bare.decisions.values()]
        .map((decision) => decision.label)
        .every((label) => label.startsWith("D·")),
    ).toBe(true);
    // Scenario 2 holds four advances, the last at Keel's own height of 1,144.
    expect(items.filter((event) => event.type === "TrunkAdvanced")).toHaveLength(4);
    expect(bare.trunk.advances).toBe(1144);
  });

  it("marks only the next cell as running, and the rest as still to come", async () => {
    const state = conflictPage(await playerAt(419));
    expect(outcomes(state?.matrix.cells.A.probe)).toEqual(["pass", "running", "pending"]);
    expect(outcomes(state?.matrix.cells.B["tests-a"])).toEqual(["pending"]);
    expect(outcomes(state?.matrix.cells.AB.probe)).toEqual(["pending", "pending", "pending"]);
  });

  it("never reports n/a as a pass, in any cell at any instant", async () => {
    // In B's world the probe's precondition is absent throughout. On trunk it is absent until A lands.
    const always = await Promise.all([412, 420, 430, 447, 700].map((second) => playerAt(second)));
    const beforeLanding = always.slice(0, 4);
    const seenInB = always.flatMap((player) =>
      outcomes(conflictPage(player)?.matrix.cells.B.probe),
    );
    const seenOnTrunk = beforeLanding.flatMap((player) =>
      outcomes(conflictPage(player)?.matrix.cells.trunk.probe),
    );
    expect(seenInB).toContain("n/a");
    expect(seenInB).not.toContain("pass");
    expect(seenOnTrunk).toContain("n/a");
    expect(seenOnTrunk).not.toContain("pass");
  });

  it("puts the two propositions on the lattice: a declared range and a derived point outside it", async () => {
    const state = conflictPage(await playerAt(400));
    // The line is Keel's own lattice: the branch of freshness that holds both values. A TTL is on the other branch.
    expect(state?.lattice).toEqual({
      predicate: "freshness",
      values: ["per-call", "per-request", "per-session", "static"],
      standing: "ranked",
    });
    expect(state?.parties.A.proposition).toMatchObject({
      role: "premise",
      relation: "at-most",
      value: "per-request",
      origin: "declared",
    });
    expect(state?.parties.B.proposition).toMatchObject({
      role: "effect",
      relation: "is",
      value: "per-session",
      origin: "derived",
    });
    // Each derivation says its own class: an extractor's reading of the code is a ruling, Clef's is an opinion.
    expect(state?.parties.B.proposition.derivation).toEqual([
      { method: "extractor", evidenceClass: "ruling" },
      { method: "clef", evidenceClass: "opinion", p: 0.93 },
    ]);
  });

  it("draws no line where Keel's lattice does not rank the two values, or has not been read", async () => {
    const player = await playerAt(443);
    const conflict = [...player.world.conflicts.keys()][0] ?? "";
    const withLattices = (lattices: Map<string, Lattice>) =>
      conflictPageOf(player.world, conflict, {
        probes: player.probes,
        diffs: player.diffs,
        verdicts: player.verdicts,
        lattices,
        refused: player.refused,
      });
    // Not read: nothing is drawn, and nothing is made up.
    expect(withLattices(new Map())?.lattice).toEqual({
      predicate: "freshness",
      values: [],
      standing: "unknown",
    });
    const comparison = (lattices: Map<string, Lattice>) =>
      withLattices(lattices)?.evidence.find((item) => item.by.startsWith("Lattice comparison"));
    expect(comparison(new Map())).toMatchObject({ class: "ruling" });
    expect(comparison(new Map())?.detail).toBeUndefined();
    // A lattice in which a session and a request sit on different branches: both are its values, and neither is above the other.
    const freshness = player.lattices.get("freshness");
    const forked: Lattice = {
      predicate: "freshness",
      values: freshness?.values ?? [],
      covers: [
        ...(freshness?.covers ?? []).filter((cover) => cover.upper !== "per-session"),
        { lower: "per-call", upper: "per-session" },
      ],
    };
    expect(withLattices(new Map([["freshness", forked]]))?.lattice).toEqual({
      predicate: "freshness",
      values: [],
      standing: "unranked",
    });
    // As Keel has it, the lattice rules, and says how.
    expect(comparison(player.lattices)?.detail).toBe(
      "Deterministic: per-call < per-request < per-session < static.",
    );
  });

  it("holds at the question until someone rules, then follows their ruling", async () => {
    const player = await playerAt(9999, "live");
    expect(player.held).toBe(true);
    expect(player.t).toBe(472_000);
    const [escalation] = openEscalations(player.world);
    expect(escalation).toMatchObject({
      label: "E-1",
      question: "May permission checks be cached within a session?",
    });
    expect(escalation).toMatchObject({
      category: "permission-semantics",
      default: "hold",
      precedents: [],
    });
    expect(escalation?.evidence.length).toBeGreaterThan(0);
    // The default is what stands while nobody has answered. It is said, and the other three are offered.
    const asked = choicesOf(escalation ?? never());
    expect(asked.choices.map((option) => option.id)).toEqual([
      "no-cache",
      "invalidate",
      "allow-stale",
    ]);
    expect(asked.standing).toBe("Both changes wait. Nothing lands on this subject.");
    expect(trunkStatsOf(player.world, player.t)).toMatchObject({
      redCount: 0,
      advances: 0,
      changesLanded: 0,
      humansAsked: 1,
    });

    await player.rule(escalation?.id ?? "", "invalidate");
    expect(player.held).toBe(false);
    expect(openEscalations(player.world)).toEqual([]);
    player.seek(9_999_000);
    expect(trunkStatsOf(player.world, player.t)).toMatchObject({
      redCount: 0,
      advances: 2,
      changesLanded: 2,
      humansAsked: 1,
    });
    expect(outcomes(conflictPage(player)?.matrix.cells.AB.probe)).toEqual(["pass", "pass", "pass"]);
  });

  it("gives the same world whether it plays forward or is wound back and replayed", async () => {
    const forward = await playerAt(700);
    const rewound = await playerAt(700);
    rewound.seek(100_000);
    // Wound back, the world is the log up to that instant and nothing later.
    expect(rewound.world.conflicts.size).toBe(0);
    expect(trunkStatsOf(rewound.world, rewound.t).changesLanded).toBe(0);
    rewound.seek(700_000);
    expect(JSON.stringify(conflictPage(rewound))).toBe(JSON.stringify(conflictPage(forward)));
    expect(JSON.stringify(trunkStatsOf(rewound.world, rewound.t))).toBe(
      JSON.stringify(trunkStatsOf(forward.world, forward.t)),
    );
  });

  it("builds B's page from the log: drift, verdict, plan and the notes pinned to the diff", async () => {
    const player = await playerAt(460);
    const b = [...player.world.changes.values()].find((change) => change.label === "#1");
    player.wantDiff(b?.id ?? "");
    await Promise.resolve();
    await Promise.resolve();
    const file = changePageOf(player.world, b?.id ?? "", player);
    expect(file?.change).toMatchObject({
      label: "#1",
      state: "parked",
      revision: 1,
      commit: "e5f6a7b",
    });
    // The workspace it started in: Keel says which when the change starts.
    expect(file?.change.workspace).toMatch(/^ws-[0-9a-z]{8}$/);
    expect(file?.drift.map((item) => item.class)).toEqual(["silent-retraction"]);
    expect(file?.verdict).toMatchObject({ outcome: "park" });
    expect(file?.escalation).toMatchObject({ label: "E-1", state: "open" });
    expect(file?.plan.steps.map((step) => [step.id, step.outcome])).toEqual([
      ["diff", "pass"],
      ["protected", "pass"],
      ["extract", "pass"],
      ["clef", "annotate"],
      ["lattice", "fail"],
      ["typecheck", "pass"],
      ["unit", "pass"],
      ["probe", "fail"],
      ["ruling", "waiting"],
    ]);
    expect(file?.diff.files.map((entry) => entry.path)).toEqual([
      "src/authz/check.ts",
      "src/authz/cache.ts",
    ]);
    expect(file?.diff.annotations.map((note) => [note.path, note.kind])).toEqual([
      ["src/authz/check.ts", "premise"],
      ["src/authz/cache.ts", "effect"],
    ]);
  });
});

describe("the project the console is showing", () => {
  it("is named from Keel's log, and named again after the log is wound back", async () => {
    expect(new World().project).toBeUndefined();
    const player = await playerAt(700);
    expect(player.world.project).toMatchObject({ name: "demo" });
    expect(player.world.project?.id).toMatch(/^prj_/);
    player.seek(100_000);
    expect(player.world.project).toMatchObject({ name: "demo" });
  });
});

describe("what a conflict's page ties it to", () => {
  it("is its question while a person is being asked, and what it left once it is settled", async () => {
    const held = conflictPage(await playerAt(9999, "live"));
    expect(held?.conflict.summary).toMatch(/\S/);
    expect(held?.escalation).toMatchObject({
      label: "E-1",
      state: "open",
      question: "May permission checks be cached within a session?",
    });
    // The probe that proved it is a guard from the moment it is proven; the decision waits for the answer.
    expect(held?.guard).toMatchObject({ label: "G-1", state: "admitted" });
    expect(held?.decision).toBeUndefined();
    const settled = conflictPage(await playerAt(9999));
    expect(settled?.escalation).toMatchObject({ label: "E-1", state: "ruled" });
    expect(settled?.guard).toMatchObject({ label: "G-1", state: "admitted" });
    expect(settled?.decision).toMatchObject({
      label: "D-1",
      chosen: "Cache allowed if revocation invalidates it",
    });
  });
});

describe("a change's diff", () => {
  it("says whether it is still being read, has been read, or Keel would not give it", async () => {
    const player = await playerAt(700);
    const id = [...player.world.changes.values()].find((change) => change.label === "#1")?.id ?? "";
    expect(changePageOf(player.world, id, player)?.diff).toMatchObject({
      state: "reading",
      files: [],
    });
    player.wantDiff(id);
    await Promise.resolve();
    await Promise.resolve();
    expect(changePageOf(player.world, id, player)?.diff.state).toBe("read");
    expect(changePageOf(player.world, id, player)?.diff.files.length).toBeGreaterThan(0);

    const refusing = showing({
      ...createMockSource({ scenario: "s1", seed: 42 }),
      getDiff: () => Promise.reject(new Error("Keel does not serve this")),
    });
    await refusing.load();
    refusing.seek(700_000);
    refusing.wantDiff(id);
    await Promise.resolve();
    await Promise.resolve();
    expect(changePageOf(refusing.world, id, refusing)?.diff).toMatchObject({
      state: "refused",
      files: [],
    });
  });
});
