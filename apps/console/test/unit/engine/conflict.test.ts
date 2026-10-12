import { describe, expect, it } from "vitest";
import { conflictDetailOf } from "../../../src/engine/conflict.ts";
import type { Resources } from "../../../src/engine/select.ts";
import { conflictPageOf } from "../../../src/engine/select.ts";
import { contradictionsOf, sidesOf } from "../../../src/engine/sides.ts";
import type { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { World } from "../../../src/engine/world.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";
import { declareChange, foldedLog, openingOf, premiseOn } from "./script.ts";

const NOTHING_READ: Resources = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set(),
};

const CONFLICT = { kind: "conflict", id: "cfl_1" } as const;

/** Two changes of one agent, each relying on the subject `a`. */
function twoOnOneSubject(): ScriptBuilder {
  const b = openingOf(11, [["agt_1", "hosted"]], ["a"]);
  declareChange(b, "chg_1", "agt_1", [premiseOn("a")]);
  declareChange(b, "chg_2", "agt_1", [premiseOn("a")]);
  return b;
}

/** A probe's run in a world, as Keel records it. */
function ran(b: ScriptBuilder, world: "trunk" | "A-noop" | "A" | "B" | "AB", run: number): void {
  b.after(1).emit({
    type: "ProbeRan",
    entity: { kind: "probe", id: "prb_1" },
    payload: {
      probeId: "prb_1",
      conflictId: "cfl_1",
      world,
      run,
      outcome: world === "AB" ? "fail" : "pass",
      resultRef: `r2:${world}/${run}`,
    },
  });
}

describe("a conflict, as Keel names it", () => {
  it("[conflict.sides] takes the two sides from Keel's suspicion, and works neither out from what the changes declared", () => {
    const b = twoOnOneSubject();
    // Both changes rely on `a`. Keel says which holds the premise at stake, and it is the second of the parties;
    // the first makes the effect, which it declared and which no derivation of the console's holds.
    b.after(1).emit({
      type: "ConflictSuspected",
      entity: CONFLICT,
      label: "C-1",
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_1", "chg_2"],
        subjectId: "sub_a",
        subjectKey: "a",
        predicate: "bound",
        origin: "fallout",
        premise: { holder: "chg_2", proposition: premiseOn("a") },
        effect: {
          changeId: "chg_1",
          proposition: { subject: "a", predicate: "bound", relation: "is", value: "loose" },
          evidence: { declared: true, evidenceClass: "testimony" },
        },
      },
    });
    const world = foldedLog(b);
    const conflict = world.conflicts.get("cfl_1");
    if (conflict === undefined) throw new Error("the conflict was not folded");
    expect(sidesOf(world, conflict)).toMatchObject({
      holder: { id: "chg_2" },
      other: { id: "chg_1" },
    });
    const page = conflictPageOf(world, "cfl_1", NOTHING_READ);
    expect(page?.parties?.A).toMatchObject({
      world: "A",
      changeId: "chg_2",
      proposition: { role: "premise", relation: "at-most", value: "tight" },
    });
    expect(page?.parties?.B).toMatchObject({
      world: "B",
      changeId: "chg_1",
      proposition: {
        role: "effect",
        relation: "is",
        value: "loose",
        evidence: { declared: true, evidenceClass: "testimony" },
      },
    });
    // The change that makes the effect is the one that contradicts, and what it contradicts is Keel's premise.
    expect(contradictionsOf(world, "chg_2")).toEqual([]);
    expect(
      contradictionsOf(world, "chg_1").map(({ premise }) => [premise.holder, premise.proposition]),
    ).toEqual([["chg_2", premiseOn("a")]]);
    expect(page?.conflict).toMatchObject({ title: "a · bound", origin: "fallout" });
  });

  it("[conflict.no-sides] has a page for a conflict Keel suspected without naming a premise and an effect", () => {
    const b = twoOnOneSubject();
    // A change against a tenet trunk already holds, proven by the guard that failed. Keel names its parties
    // and no two sides, and no subject either.
    b.after(1).emit({
      type: "ConflictSuspected",
      entity: CONFLICT,
      label: "C-1",
      payload: { conflictId: "cfl_1", kind: "precedent", parties: ["chg_1", "tnt_1"] },
    });
    b.after(1).emit({
      type: "ConflictProven",
      entity: CONFLICT,
      payload: { conflictId: "cfl_1", evidence: { _tag: "guard", guardId: "grd_1" } },
    });
    const world = foldedLog(b);
    const conflict = world.conflicts.get("cfl_1");
    if (conflict === undefined) throw new Error("the conflict was not folded");
    expect(sidesOf(world, conflict)).toBeNull();
    expect(conflictDetailOf(world, "cfl_1")).not.toHaveProperty("sides");
    const page = conflictPageOf(world, "cfl_1", NOTHING_READ);
    expect(page).not.toBeNull();
    expect(page).not.toHaveProperty("parties");
    expect(page).not.toHaveProperty("subject");
    expect(page).not.toHaveProperty("probe");
    expect(page?.conflict).toMatchObject({
      title: "Conflict C-1",
      state: "proven",
      proven: "a guard",
    });
    // Every party Keel named is on the page: the change by its name, and the tenet as one.
    expect(page?.named).toEqual([
      { changeId: "chg_1", label: world.changes.get("chg_1")?.label },
      { label: "a tenet on trunk" },
    ]);
    // Nothing ran, and nothing is said to be waited for.
    expect(page?.matrix.rows.map((row) => [row.id, row.suites, row.runs])).toEqual([
      ["trunk", [], []],
      ["A-noop", [], []],
      ["A", [], []],
      ["B", [], []],
      ["AB", [], []],
    ]);
    expect(page?.evidence).toEqual([]);
  });

  it("[conflict.matrix] keeps a probe's runs in run order and a suite's latest run, whatever order Keel's events arrive in", () => {
    const b = twoOnOneSubject();
    b.after(1).emit({
      type: "ConflictSuspected",
      entity: CONFLICT,
      label: "C-1",
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_1", "chg_2"],
        subjectKey: "a",
        predicate: "bound",
        premise: { holder: "chg_1", proposition: premiseOn("a") },
        effect: { changeId: "chg_2", proposition: premiseOn("a", "loose") },
      },
    });
    b.after(1).emit({
      type: "ProbeDrafted",
      entity: { kind: "probe", id: "prb_1" },
      label: "P-1",
      payload: { probeId: "prb_1", conflictId: "cfl_1", attempts: 2, bundleHash: "sha256:b" },
    });
    // Keel runs the worlds side by side: the composed world's third run is in before its first.
    for (const run of [3, 1, 2]) ran(b, "AB", run);
    ran(b, "A", 1);
    const check = (run: number, outcome: "pass" | "fail"): void => {
      b.after(1).emit({
        type: "WorldCheckRan",
        entity: CONFLICT,
        payload: {
          conflictId: "cfl_1",
          world: "AB",
          check: "suite:chg_1",
          run,
          outcome,
          counts: {
            passed: outcome === "pass" ? 9 : 8,
            failed: outcome === "pass" ? 0 : 1,
            skipped: 1,
          },
        },
      });
    };
    // The suite is run twice, and the second run is recorded first.
    check(2, "fail");
    check(1, "pass");
    const world = foldedLog(b);
    const detail = conflictDetailOf(world, "cfl_1");
    expect(detail?.matrix.map((row) => row.world)).toEqual(["trunk", "A-noop", "A", "B", "AB"]);
    const composed = detail?.matrix.find((row) => row.world === "AB");
    expect(composed?.probe.map((run) => [run.run, run.outcome, run.resultRef])).toEqual([
      [1, "fail", "r2:AB/1"],
      [2, "fail", "r2:AB/2"],
      [3, "fail", "r2:AB/3"],
    ]);
    expect(composed?.checks.map((suite) => [suite.check, suite.run, suite.outcome])).toEqual([
      ["suite:chg_1", 2, "fail"],
    ]);
    expect(detail?.probe).toEqual({
      id: "prb_1",
      label: "P-1",
      state: "calibrating",
      attempts: 2,
      bundleHash: "sha256:b",
    });
    // The page counts a suite's tests as Keel did: passed, of all it ran or skipped.
    const page = conflictPageOf(world, "cfl_1", NOTHING_READ);
    expect(page?.matrix.rows.find((row) => row.id === "AB")?.suites).toEqual([
      {
        check: "suite:chg_1",
        label: `A's suite · ${world.changes.get("chg_1")?.label ?? ""}`,
        outcome: "fail",
        passed: 8,
        total: 10,
      },
    ]);
    // One run is in where the holder stands alone, and two are still to come.
    expect(page?.matrix.rows.find((row) => row.id === "A")?.runs).toEqual([
      "pass",
      "pending",
      "pending",
    ]);
  });

  it("[conflict.asked] carries the question a person was asked where the log holds it, and what the ruling chose, as Keel's read of the conflict does", async () => {
    // A member's log holds the question. Folded to its end, with the ruling given, the conflict's shape has
    // what was asked, how it stands, its options and evidence, and the option the decision chose.
    const source = createMockSource({ scenario: "s1", seed: 42, ruling: "invalidate" });
    const member = showing(source);
    await member.load();
    member.seek(9_999_000);
    const [id = ""] = member.world.conflicts.keys();
    const detail = conflictDetailOf(member.world, id);
    expect(detail?.escalation).toMatchObject({
      label: "E-1",
      open: false,
      question: "May permission checks be cached within a session?",
      state: "ruled",
    });
    expect(detail?.escalation?.options?.map((option) => option.id)).toContain("invalidate");
    expect(detail?.escalation?.evidence?.length).toBeGreaterThan(0);
    expect(detail?.decision).toEqual({
      id: member.world.conflicts.get(id)?.decisionId,
      label: "D-1",
      chosen: { id: "invalidate", label: member.world.decisions.values().next().value?.chosen },
    });
    // The page is drawn from that shape alone: the question, the question's own evidence, the decision.
    const page = conflictPageOf(member.world, id, NOTHING_READ);
    expect(page?.escalation).toMatchObject({ label: "E-1", state: "ruled" });
    expect(page?.decision).toMatchObject({ label: "D-1" });
    expect(page?.evidence.map((line) => line.summary)).toEqual(
      detail?.escalation?.evidence?.map((line) => line.summary),
    );

    // Anyone else is read the public part of the log, which holds no question: that a person was asked, and
    // why, is all the shape then has, and the page lists Keel's records in the question's place.
    const world = new World();
    const log = await source.readEvents();
    log.items
      .filter((event) => event.type !== "EscalationRaised" && event.type !== "DecisionRecorded")
      .forEach((event, index) => world.apply(event, index));
    const told = conflictDetailOf(world, id);
    expect(told?.escalation).toEqual({
      id: told?.escalation?.id,
      open: false,
      reason: "human-class",
    });
    expect(told?.decision).toEqual({ id: told?.decision?.id });
    const shown = conflictPageOf(world, id, NOTHING_READ);
    expect(shown).not.toHaveProperty("escalation");
    expect(shown).not.toHaveProperty("decision");
    expect(shown?.escalated).toBe("human-class");
    expect(shown?.evidence.every((line) => line.by !== "")).toBe(true);
  });

  it("[probe.discarded] says why Keel discarded a probe none of whose drafts it kept, which was never drafted in the log", () => {
    const b = twoOnOneSubject();
    b.after(1).emit({
      type: "ConflictSuspected",
      entity: CONFLICT,
      label: "C-1",
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_1", "chg_2"],
        subjectKey: "a",
        predicate: "bound",
        premise: { holder: "chg_1", proposition: premiseOn("a") },
        effect: { changeId: "chg_2", proposition: premiseOn("a", "loose") },
      },
    });
    b.after(1).emit({
      type: "ProbeDiscarded",
      entity: { kind: "probe", id: "prb_1" },
      label: "P-1",
      payload: {
        probeId: "prb_1",
        conflictId: "cfl_1",
        reason: "draft-failed",
        detail: "repairs-exhausted",
      },
    });
    const world = foldedLog(b);
    expect(conflictDetailOf(world, "cfl_1")?.probe).toEqual({
      id: "prb_1",
      label: "P-1",
      state: "discarded",
      discarded: { reason: "draft-failed", detail: "repairs-exhausted" },
    });
    const page = conflictPageOf(world, "cfl_1", NOTHING_READ);
    expect(page?.probe).toEqual({
      id: "prb_1",
      label: "P-1",
      state: "discarded",
      discarded: { reason: "draft-failed", detail: "repairs-exhausted" },
      source: "unread",
    });
    // It never ran, so its row holds three runs that did not happen and nothing says one is coming.
    expect(page?.matrix).toMatchObject({ probe: "P-1", calibrating: false });
  });
});
