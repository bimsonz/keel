import { describe, expect, it } from "vitest";
import type { EntityRef } from "../../../../src/contract/envelope.ts";
import type { ProbeOutcome, ProbeWorld } from "../../../../src/contract/events.ts";
import { createRng } from "../../../fixtures/prng.ts";
import { ScriptBuilder } from "../../../fixtures/mock/builder.ts";
import { admission, checkLog } from "../../../fixtures/mock/conformance.ts";
import { generateS3, generateS4 } from "../../../fixtures/mock/proven.ts";
import { generateS1 } from "../../../fixtures/mock/s1.ts";
import { generateS5 } from "../../../fixtures/mock/same.ts";
import type { ScriptedEvent } from "../../../fixtures/mock/scripted.ts";

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

/** The problems the check finds in a story once `rewrite` has changed it into one Keel could not have told. */
function told(
  generate: (seed: number) => { events: ScriptedEvent[] },
  rewrite: (events: ScriptedEvent[]) => void,
): string[] {
  const events = structuredClone(generate(42).events);
  rewrite(events);
  // Only what the problem is: where in the log it was found is not what these checks are about.
  return checkLog(events).map((problem) => problem.replace(/^#\d+ /, ""));
}

const bounces = (events: ScriptedEvent[]) =>
  events.filter((event) => event.type === "ChangeBounced");
const notes = (events: ScriptedEvent[]) => events.filter((event) => event.type === "ConflictNoted");

/** Scenario 1 under a ruling that goes against one side, and the resolution that says so. */
const ruled = (seed: number) => generateS1(seed, "invalidate");
const resolutionOf = (events: ScriptedEvent[]) => {
  const resolved = events.find((event) => event.type === "ConflictResolved");
  if (resolved?.type !== "ConflictResolved") throw new Error("scenario 1 resolves nothing");
  return resolved.payload;
};

describe("what a ruling does to the change it goes against, held to Keel's rule", () => {
  const NOT_AGAINST = expect.stringMatching(
    /^ChangeBounced: no resolution by dec_\w+ went against chg_\w+$/,
  );

  it("[conformance.ruling-bounce] refuses a ruling's bounce of a change its resolution did not go against, and of one that was not waiting for the ruling", () => {
    expect(checkLog(ruled(42).events)).toEqual([]);
    // The resolution goes against nobody.
    expect(
      told(ruled, (events) => {
        delete resolutionOf(events).against;
      }),
    ).toEqual([NOT_AGAINST]);
    // It goes against the other side.
    expect(
      told(ruled, (events) => {
        const other = events.find((event) => event.type === "ChangeResumed");
        if (other?.type === "ChangeResumed")
          resolutionOf(events).against = [other.payload.changeId];
      }),
    ).toEqual([NOT_AGAINST]);
    // The change was never parked for the ruling.
    const unparked = told(ruled, (events) => {
      const bounced = bounces(events)[0]?.payload.changeId;
      const at = events.findIndex(
        (event) => event.type === "ChangeParked" && event.payload.changeId === bounced,
      );
      events.splice(at, 1);
    });
    // A bounce on a verdict may follow a verification; a ruling's may not.
    expect(unparked).toContainEqual(
      expect.stringMatching(
        /^ChangeBounced: change:chg_\w+ is verifying, which this event cannot follow$/,
      ),
    );
  });

  it("[conformance.resolution-against] refuses a resolution that goes against nobody, against a change that is no side of its conflict, or against anyone with no decision", () => {
    expect(
      told(ruled, (events) => {
        resolutionOf(events).against = [];
      }),
    ).toEqual([
      "ConflictResolved: a resolution goes against a party only by a decision, and never against none",
      NOT_AGAINST,
    ]);
    expect(
      told(ruled, (events) => {
        resolutionOf(events).against = ["chg_stranger"];
      }),
    ).toEqual([
      expect.stringMatching(/^ConflictResolved: chg_stranger is not one of cfl_\w+'s sides$/),
      NOT_AGAINST,
    ]);
    expect(
      told(ruled, (events) => {
        delete resolutionOf(events).decisionId;
      }),
    ).toContain(
      "ConflictResolved: a resolution goes against a party only by a decision, and never against none",
    );
  });
});

describe("how a conflict is resolved, held to Keel's rule", () => {
  it("[conformance.resolution-by-ruling] refuses a conflict resolved with no ruling's decision, or before it was put to a person", () => {
    // Scenario 4's conflict is proven and bounces its change, and nobody is asked: Keel leaves it proven.
    expect(checkLog(generateS4(42).events)).toEqual([]);
    expect(
      told(generateS4, (events) => {
        const proof = events.findLast((event) => event.type === "ConflictProven");
        const last = events.at(-1);
        if (proof?.type !== "ConflictProven" || last === undefined)
          throw new Error("scenario 4 proves nothing");
        events.push({
          eventId: `${last.eventId}_resolved`,
          at: last.at,
          seq: events.filter((event) => event.entity.id === proof.payload.conflictId).length + 1,
          entity: proof.entity,
          type: "ConflictResolved",
          payload: {
            _tag: "ConflictResolved",
            conflictId: proof.payload.conflictId,
            move: "escalate",
          },
        });
      }),
    ).toEqual([
      "ConflictResolved: Keel resolves a conflict only by a ruling's decision",
      expect.stringMatching(
        /^ConflictResolved: conflict:cfl_\w+ is proven, which this event cannot follow$/,
      ),
    ]);
  });
});

describe("what a proof does to a change, held to Keel's rule", () => {
  it("[conformance.bounce-cause] refuses a bounce that names two causes, or a verdict nobody issued", () => {
    expect(
      told(generateS4, (events) => {
        const [first] = bounces(events);
        if (first !== undefined) first.payload.verdictId = "vrd_never";
      }),
    ).toEqual([
      "ChangeBounced: a bounce names exactly one cause: its verdict, its conflict, its declined batch or the decision that went against it",
      "ChangeBounced: verdict vrd_never was not issued",
    ]);
  });

  it("[conformance.bounce-blocks] refuses a bounce on a conflict when the change's plan does not block on its predicate", () => {
    expect(
      told(generateS4, (events) => {
        for (const event of events)
          if (event.type === "PlanCompiled") delete event.payload.predicatePolicy;
      }),
    ).toEqual([
      "ChangeBounced: the change's plan does not block on the conflict's predicate (advise)",
      "ChangeBounced: the change's plan does not block on the conflict's predicate (advise)",
    ]);
    // A plan that blocks on another predicate does not block on this one.
    expect(
      told(generateS4, (events) => {
        for (const event of events)
          if (event.type === "PlanCompiled") event.payload.predicatePolicy = { ordering: "block" };
      }),
    ).toHaveLength(2);
  });

  it("[conformance.bounce-proven] refuses a bounce on a conflict that was not proven, or that the change is no side of", () => {
    // The proof is taken out of the log: both bounces now cite a conflict nobody proved.
    expect(
      told(generateS4, (events) => {
        events.splice(
          events.findIndex((event) => event.type === "ConflictProven"),
          1,
        );
      }).filter((problem) => problem.endsWith("was not proven")),
    ).toHaveLength(2);
    // The first bounce is said of a conflict that change has no part in.
    const [first] = bounces(generateS4(42).events);
    expect(
      told(generateS4, (events) => {
        const [bounce] = bounces(events);
        if (bounce !== undefined) bounce.payload.conflictId = "cfl_another";
      }),
    ).toEqual([
      "ChangeBounced: cfl_another was not proven",
      `ChangeBounced: ${first?.payload.changeId} is not one of cfl_another's sides`,
      "ChangeBounced: the change's plan does not block on the conflict's predicate (advise)",
    ]);
  });

  it("[conformance.bounce-declined] takes a bounce on a declined batch only from a change that is in a batch", () => {
    expect(
      told(generateS4, (events) => {
        const [first] = bounces(events);
        if (first === undefined) return;
        delete first.payload.conflictId;
        first.payload.declined = { batchId: "bat_1", reason: "pack-too-large" };
      }),
    ).toEqual([
      expect.stringMatching(
        /^ChangeBounced: change:chg_\w+ is verifying, which this event cannot follow$/,
      ),
    ]);
  });

  it("[conformance.note-policy] refuses a note whose policy is not the one the change's plan compiled", () => {
    expect(
      told(generateS3, (events) => {
        const [first] = notes(events);
        if (first !== undefined) first.payload.policy = "annotate";
      }),
    ).toEqual([
      "ConflictNoted: noted as annotate, and the change's plan says advise",
      "ConflictNoted: only an advised change is told its ways forward",
    ]);
    // The same notes under plans that block: Keel would have bounced both.
    expect(
      told(generateS3, (events) => {
        for (const event of events)
          if (event.type === "PlanCompiled") event.payload.predicatePolicy = { freshness: "block" };
      }),
    ).toEqual([
      "ConflictNoted: noted as advise, and the change's plan says block",
      "ConflictNoted: noted as advise, and the change's plan says block",
    ]);
  });

  it("[conformance.note-evidence] holds a note to the proof's own evidence, and to telling an advised change its ways forward", () => {
    const proven = generateS3(42).events.find((event) => event.type === "ConflictProven");
    const probe = proven?.payload.evidence._tag === "probe" ? proven.payload.evidence.probeId : "";
    expect(
      told(generateS3, (events) => {
        const [first, second] = notes(events);
        if (first !== undefined) delete first.payload.evidenceRef;
        if (second !== undefined) delete second.payload.nextActions;
      }),
    ).toEqual([
      `ConflictNoted: its evidence is none, and the proof's is probe:${probe}`,
      "ConflictNoted: only an advised change is told its ways forward",
    ]);
  });
});

/** The id of the change a story declared under `label`. */
const declaredAs = (events: ScriptedEvent[], label: string): string =>
  events.find((event) => event.type === "IntentDeclared" && event.label === label)?.entity.id ?? "";

describe("changes with the same intent, held to Keel's rule", () => {
  it("[conformance.alternative-intent] refuses a notice or a preflight naming a change whose declared effects make other claims", () => {
    // #4 declares another limit on the same subject: a neighbour, and no one's alternative.
    const four = declaredAs(generateS5(42).events, "#4");
    const one = declaredAs(generateS5(42).events, "#1");
    expect(
      told(generateS5, (events) => {
        const notice = events.find((event) => event.type === "AlternativeDeclared");
        if (notice !== undefined) notice.payload.alternativeId = four;
      }),
    ).toEqual([
      `AlternativeDeclared: ${four} does not have the same intent as ${one}`,
      // And #4 had not been declared when that notice was sent.
      `AlternativeDeclared: ${four} is not a live change`,
    ]);
    expect(
      told(generateS5, (events) => {
        const preflight = events.find(
          (event) => event.type === "PreflightIssued" && event.payload.changeId === four,
        );
        if (preflight?.type === "PreflightIssued") preflight.payload.alternatives = [one, four];
      }),
    ).toEqual([
      `PreflightIssued: ${one} does not have the same intent as ${four}`,
      `PreflightIssued: ${four} is not an alternative to itself`,
    ]);
  });

  it("[conformance.alternative-landed] refuses word of a landing for a change that has not landed, and a list of none", () => {
    const three = declaredAs(generateS5(42).events, "#3");
    expect(
      told(generateS5, (events) => {
        const notice = events.find(
          (event) => event.type === "AlternativeLanded" && event.payload.changeId !== three,
        );
        if (notice?.type === "AlternativeLanded") notice.payload.landedChangeId = three;
      }),
    ).toEqual([`AlternativeLanded: ${three} has not landed`]);
    expect(
      told(generateS5, (events) => {
        const preflight = events.find((event) => event.type === "PreflightIssued");
        if (preflight !== undefined) preflight.payload.alternatives = [];
      }),
    ).toEqual(["PreflightIssued: it lists no alternatives, and says so"]);
  });

  it("[conformance.alternative-live] refuses naming a change that has ended as one still being attempted", () => {
    const two = declaredAs(generateS5(42).events, "#2");
    const three = declaredAs(generateS5(42).events, "#3");
    // Keel tells #3 that #2 was declared, after #2 was withdrawn.
    expect(
      told(generateS5, (events) => {
        const landed = events.findLast((event) => event.type === "AlternativeLanded");
        if (landed?.type !== "AlternativeLanded") return;
        events.push({
          ...landed,
          type: "AlternativeDeclared",
          eventId: "evt_zzzzzzzzzzzzzzzzzzzzzzzzzz",
          seq: landed.seq + 1,
          payload: {
            _tag: "AlternativeDeclared",
            projectId: landed.payload.projectId,
            changeId: three,
            alternativeId: two,
            nextActions: landed.payload.nextActions,
          },
        });
      }),
    ).toEqual([`AlternativeDeclared: ${two} is not a live change`]);
  });
});
