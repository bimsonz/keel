import { describe, expect, it } from "vitest";
import type { EntityRef } from "../../../../src/contract/envelope.ts";
import type { ProbeOutcome, ProbeWorld } from "../../../../src/contract/events.ts";
import { createRng } from "../../../fixtures/prng.ts";
import { ScriptBuilder } from "../../../fixtures/mock/builder.ts";
import { admission, checkLog } from "../../../fixtures/mock/conformance.ts";

type Cells = [ProbeWorld, number, ProbeOutcome][];

/** Three runs that all discriminate: the matrix that admits a probe. */
const ADMITS: Cells = [1, 2, 3].flatMap((run): Cells => [
  ["trunk", run, "n/a"],
  ["A-noop", run, "fail"],
  ["A", run, "pass"],
  ["B", run, "n/a"],
  ["AB", run, "fail"],
]);

/** One complete run: it passes on trunk and in A, and answers `ab` in A+B and `noop` in the control. */
const run1 = (ab: ProbeOutcome, noop: ProbeOutcome) => [
  { world: "trunk" as const, run: 1, outcome: "pass" as const },
  { world: "A-noop" as const, run: 1, outcome: noop },
  { world: "A" as const, run: 1, outcome: "pass" as const },
  { world: "AB" as const, run: 1, outcome: ab },
];

interface Story {
  b: ScriptBuilder;
  conflict: string;
  conflictRef: EntityRef;
  probe: string;
  probeRef: EntityRef;
}

/** A semantic conflict whose probe has recorded `cells`. `then` says what follows. */
function problems(cells: Cells, then: (story: Story) => void = () => {}): string[] {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(7));
  const conflict = b.at(1).id("cfl");
  const conflictRef: EntityRef = { kind: "conflict", id: conflict };
  b.emit({
    type: "ConflictSuspected",
    entity: conflictRef,
    payload: {
      conflictId: conflict,
      kind: "semantic",
      parties: ["chg_1", "chg_2"],
      subjectId: "sub_1",
      predicate: "freshness",
    },
  });
  const probe = b.at(2).id("prb");
  const probeRef: EntityRef = { kind: "probe", id: probe };
  b.emit({
    type: "ProbeDrafted",
    entity: probeRef,
    payload: { probeId: probe, conflictId: conflict, attempts: 1, bundleHash: "sha256:00" },
  });
  cells.forEach(([world, run, outcome], index) => {
    b.at(3 + index).emit({
      type: "ProbeRan",
      entity: probeRef,
      payload: {
        probeId: probe,
        conflictId: conflict,
        world,
        run: run === 1 ? 1 : run === 2 ? 2 : 3,
        outcome,
        resultRef: "r2:x",
      },
    });
  });
  b.at(100);
  then({ b, conflict, conflictRef, probe, probeRef });
  return checkLog(b.build().events);
}

const admit = ({ b, conflict, probe, probeRef }: Story, guardId = "grd_1"): void => {
  b.emit({
    type: "GuardAdmitted",
    entity: probeRef,
    payload: { guardId, probeId: probe, conflictId: conflict, runs: 3 },
  });
};

describe("Keel's admission rule", () => {
  it("admits after three complete runs that all discriminate, and not before", () => {
    expect(admission(ADMITS.map(([world, run, outcome]) => ({ world, run, outcome })))).toBe(
      "admitted",
    );
    expect(
      admission(
        ADMITS.filter(([, run]) => run < 3).map(([world, run, outcome]) => ({
          world,
          run,
          outcome,
        })),
      ),
    ).toBe("pending");
  });

  it("does not let B decide, and takes a probe that does not apply on trunk", () => {
    const withoutB = ADMITS.filter(([world]) => world !== "B");
    expect(admission(withoutB.map(([world, run, outcome]) => ({ world, run, outcome })))).toBe(
      "admitted",
    );
  });

  it("discards at the first complete run that does not discriminate", () => {
    expect(admission(run1("pass", "fail"))).toBe("non-discriminating");
    // A probe that passes with the premise removed never tested the premise.
    expect(admission(run1("fail", "pass"))).toBe("non-discriminating");
    expect(admission(run1("fail", "n/a"))).toBe("non-discriminating");
    expect(admission(run1("fail", "fail"))).toBe("pending");
  });

  it("calls a probe unstable when some runs discriminate and one does not", () => {
    const cells = ADMITS.map(([world, run, outcome]) => ({
      world,
      run,
      outcome: world === "AB" && run === 2 ? ("pass" as const) : outcome,
    }));
    expect(admission(cells)).toBe("unstable");
  });

  it("never completes a run that has no control world, so never admits on one", () => {
    expect(
      admission(
        ADMITS.filter(([world]) => world !== "A-noop").map(([world, run, outcome]) => ({
          world,
          run,
          outcome,
        })),
      ),
    ).toBe("pending");
  });
});

describe("the check the fixtures are held to", () => {
  it("passes a probe that is admitted by its matrix, proves its conflict, and is retired under its guard's name", () => {
    expect(
      problems(ADMITS, (story) => {
        admit(story);
        story.b.emit({
          type: "ConflictProven",
          entity: story.conflictRef,
          payload: {
            conflictId: story.conflict,
            evidence: { _tag: "probe", probeId: story.probe },
          },
        });
        story.b.emit({
          type: "GuardRetired",
          entity: story.probeRef,
          payload: { guardId: "grd_1", decisionId: "dec_1" },
        });
      }),
    ).toEqual([]);
  });

  it("refuses a guard that is an entity of its own", () => {
    const found = problems(ADMITS, ({ b, conflict, probe }) => {
      b.emit({
        type: "GuardAdmitted",
        entity: { kind: "guard", id: "grd_1" },
        payload: { guardId: "grd_1", probeId: probe, conflictId: conflict, runs: 3 },
      });
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/GuardAdmitted: entity is guard:grd_1, expected probe:prb_/);
  });

  it("refuses an admission the matrix has not reached", () => {
    expect(problems(ADMITS.slice(0, 10), (story) => admit(story))).toEqual([
      "#12 GuardAdmitted: the matrix does not admit this probe (pending)",
    ]);
  });

  it("refuses a cell recorded after the matrix was decided", () => {
    const decoy: Cells = [
      ["trunk", 1, "pass"],
      ["A-noop", 1, "fail"],
      ["A", 1, "pass"],
      ["AB", 1, "pass"],
      ["AB", 2, "pass"],
    ];
    expect(problems(decoy)).toEqual([
      "#6 ProbeRan: the matrix was already decided (non-discriminating), so no further cell is recorded",
    ]);
  });

  it("refuses a discard the matrix does not agree with", () => {
    const found = problems(ADMITS, ({ b, conflict, probe, probeRef }) => {
      b.emit({
        type: "ProbeDiscarded",
        entity: probeRef,
        payload: { probeId: probe, reason: "non-discriminating", conflictId: conflict },
      });
    });
    expect(found).toEqual([
      "#17 ProbeDiscarded: discarded as non-discriminating, and the matrix says admitted",
    ]);
  });

  it("takes three failed drafts as a probe's first and only event", () => {
    const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(7));
    b.at(1).emit({
      type: "ConflictSuspected",
      entity: { kind: "conflict", id: "cfl_1" },
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_1", "chg_2"],
        subjectId: "sub_1",
        predicate: "freshness",
      },
    });
    b.at(2).emit({
      type: "ProbeDiscarded",
      entity: { kind: "probe", id: "prb_1" },
      payload: { probeId: "prb_1", reason: "draft-failed", conflictId: "cfl_1" },
    });
    b.at(3).emit({
      type: "ConflictEscalated",
      entity: { kind: "conflict", id: "cfl_1" },
      payload: { conflictId: "cfl_1", escalationId: "esc_1", reason: "unprovable" },
    });
    expect(checkLog(b.build().events)).toEqual([]);
  });

  it("refuses a suite's cell once the conflict is no longer Probing", () => {
    const found = problems(ADMITS, (story) => {
      admit(story);
      story.b.emit({
        type: "ConflictProven",
        entity: story.conflictRef,
        payload: { conflictId: story.conflict, evidence: { _tag: "probe", probeId: story.probe } },
      });
      story.b.emit({
        type: "WorldCheckRan",
        entity: story.conflictRef,
        payload: {
          conflictId: story.conflict,
          world: "AB",
          check: "suite:chg_1",
          run: 1,
          outcome: "pass",
        },
      });
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /WorldCheckRan: conflict:cfl_\w+ is proven, which this event cannot follow/,
    );
  });

  it("refuses a proof by a probe that was never admitted, and a proof of the wrong kind", () => {
    const early = problems(ADMITS.slice(0, 10), (story) => {
      story.b.emit({
        type: "ConflictProven",
        entity: story.conflictRef,
        payload: { conflictId: story.conflict, evidence: { _tag: "probe", probeId: story.probe } },
      });
    });
    expect(early).toEqual(["#12 ConflictProven: its probe was not admitted"]);
    const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(7));
    b.at(1).emit({
      type: "ConflictSuspected",
      entity: { kind: "conflict", id: "cfl_1" },
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_1", "chg_2"],
        subjectId: "sub_1",
        predicate: "freshness",
      },
    });
    b.at(2).emit({
      type: "ConflictProven",
      entity: { kind: "conflict", id: "cfl_1" },
      payload: { conflictId: "cfl_1", evidence: { _tag: "guard", guardId: "grd_1" } },
    });
    expect(checkLog(b.build().events)).toEqual([
      "#1 ConflictProven: guard does not prove a semantic conflict",
    ]);
  });

  it("refuses asking a person about a human-class conflict before it is proven", () => {
    const found = problems(ADMITS.slice(0, 10), (story) => {
      story.b.emit({
        type: "ConflictEscalated",
        entity: story.conflictRef,
        payload: { conflictId: story.conflict, escalationId: "esc_1", reason: "human-class" },
      });
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /ConflictEscalated: conflict:cfl_\w+ is probing, which this event cannot follow/,
    );
  });

  it("holds a guard's retirement and its failures to the probe admitted under that name", () => {
    const stranger = problems(ADMITS, (story) => {
      admit(story);
      story.b.emit({
        type: "GuardRetired",
        entity: story.probeRef,
        payload: { guardId: "grd_other", decisionId: "dec_1" },
      });
    });
    expect(stranger[0]).toMatch(
      /GuardRetired: entity is probe:prb_\w+, expected probe:never admitted as grd_other/,
    );

    const change: EntityRef = { kind: "change", id: "chg_9" };
    const failing = (
      payload: { changeId?: string; batchId?: string; candidateId?: string },
      entity: EntityRef,
    ): string[] =>
      problems(ADMITS, (story) => {
        admit(story);
        story.b.emit({
          type: "IntentDeclared",
          entity: change,
          payload: {
            changeId: "chg_9",
            agentId: "agt_1",
            origin: "agent",
            revision: 1,
            goal: "g",
            footprint: [],
            premises: [],
            leaseId: "lse_1",
          },
        });
        story.b.emit({
          type: "GuardFailed",
          entity,
          payload: { guardId: "grd_1", world: "A", ...payload },
        });
      });
    // In a change's own plan it is a fact of that change.
    expect(failing({ changeId: "chg_9" }, change)).toEqual([]);
    expect(failing({ changeId: "chg_9" }, { kind: "batch", id: "bat_1" })).toEqual([
      "#19 GuardFailed: entity is batch:bat_1, expected change:chg_9",
    ]);
    expect(failing({ changeId: "chg_9", batchId: "bat_1", candidateId: "cnd_1" }, change)[0]).toBe(
      "#19 GuardFailed: it is a fact of a change or of a batch, one and not both",
    );
    expect(failing({}, change)).toContain(
      "#19 GuardFailed: it is a fact of a change or of a batch, one and not both",
    );
  });
});
