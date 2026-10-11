import { describe, expect, it, vi } from "vitest";
import type { EntityRef } from "../../../../src/contract/envelope.ts";
import type { AnyEvent } from "../../../../src/contract/events.ts";
import type { DerivedEffect, Proposition } from "../../../../src/contract/mfp.ts";
import type {
  FunnelObservation,
  FunnelStage,
  FunnelStageFrame,
} from "../../../../src/contract/observations.ts";
import { createRng } from "../../../fixtures/prng.ts";
import { type GeneratedLog, ScriptBuilder } from "../../../fixtures/mock/builder.ts";
import { UNIT_USD } from "../../../fixtures/mock/funnel.ts";
import { generateS1 } from "../../../fixtures/mock/s1.ts";
import { generateS2 } from "../../../fixtures/mock/s2.ts";
import { generateSwarm } from "../../../fixtures/mock/swarm.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

function framesOf(log: GeneratedLog): FunnelObservation[] {
  return log.observations.flatMap((observation) =>
    observation.kind === "funnel" ? [observation] : [],
  );
}

function stageOf(
  frame: FunnelObservation | undefined,
  stage: FunnelStage,
): Omit<FunnelStageFrame, "stage"> | undefined {
  const found = frame?.stages.find((candidate) => candidate.stage === stage);
  return found === undefined
    ? undefined
    : {
        considered: found.considered,
        settled: found.settled,
        passedOn: found.passedOn,
        usd: found.usd,
      };
}

const change = (id: string): EntityRef => ({ kind: "change", id });
const atMost = (
  subject: string,
  predicate: Proposition["predicate"],
  value: string,
): Proposition => ({ subject, predicate, relation: "at-most", value });
const is = (subject: string, predicate: Proposition["predicate"], value: string): Proposition => ({
  subject,
  predicate,
  relation: "is",
  value,
});
const extracted = (proposition: Proposition): DerivedEffect => ({
  method: "extractor",
  evidenceClass: "ruling",
  declared: false,
  proposition,
  anchors: [],
});

/** Five changes on two subjects: small enough to count every comparison by hand. */
function handCounted(): GeneratedLog {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(1));
  const declare = (id: string, premises: Proposition[]): void => {
    b.emit({
      type: "IntentDeclared",
      entity: change(id),
      payload: {
        changeId: id,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal: "",
        footprint: [],
        premises,
        leaseId: "lse_1",
      },
    });
  };
  const derive = (id: string, revision: number, effects: DerivedEffect[]): AnyEvent =>
    b.emit({
      type: "EffectsDerived",
      entity: change(id),
      payload: { changeId: id, revision, effects, derivationRef: "" },
    });
  b.at(1);
  declare("A", [atMost("s.x", "freshness", "per-request")]);
  declare("B", [atMost("s.x", "freshness", "per-request")]);
  declare("C", [atMost("s.x", "freshness", "ttl")]);
  declare("D", [atMost("s.y", "ordering", "per-key")]);
  declare("E", [atMost("s.y", "ordering", "strict")]);
  // E alters s.x. Four premises are held by others; two distinct ones are on s.x; one of those is contradicted.
  b.at(2);
  const derivedE = derive("E", 1, [extracted(is("s.x", "freshness", "per-session"))]);
  // Keel sets E against A: that conflict, caused by this derivation, is what says which premise E contradicts.
  b.at(3).emit({
    type: "ConflictSuspected",
    entity: { kind: "conflict", id: "cfl_1" },
    payload: { conflictId: "cfl_1", kind: "semantic", parties: ["A", "E"] },
    causation: derivedE,
  });
  b.at(3.5).emit({
    type: "ConflictSuspected",
    entity: { kind: "conflict", id: "cfl_2" },
    payload: { conflictId: "cfl_2", kind: "textual", parties: ["C", "D"] },
  });
  b.at(4).emit({
    type: "ProbeDrafted",
    entity: { kind: "probe", id: "prb_1" },
    payload: { probeId: "prb_1", conflictId: "cfl_1", attempts: 2, bundleHash: "" },
  });
  // A lands, and its premise stands: the code on trunk still relies on it.
  b.at(5).emit({
    type: "ChangeLanded",
    entity: change("A"),
    payload: { changeId: "A", commitSha: "", trunkSha: "", candidateId: "", proofId: "" },
  });
  // D alters s.x, and only Clef can say how: the lattice may not rule on an opinion.
  b.at(6);
  derive("D", 1, [
    {
      method: "clef",
      evidenceClass: "opinion",
      p: 0.9,
      declared: false,
      proposition: is("s.x", "freshness", "per-call"),
      anchors: [],
    },
  ]);
  // C alters s.y, inside both premises held there.
  b.at(7);
  derive("C", 1, [extracted(is("s.y", "ordering", "strict"))]);
  // B relaxes its premise to the one C already holds. E comes back and is compared with two: that one, and A's.
  b.at(8).emit({
    type: "IntentRevised",
    entity: change("B"),
    payload: {
      changeId: "B",
      revision: 2,
      premisesAdded: [atMost("s.x", "freshness", "ttl")],
      premisesRetracted: [atMost("s.x", "freshness", "per-request")],
    },
  });
  b.at(9);
  derive("E", 2, [extracted(is("s.x", "freshness", "per-request"))]);
  return b.build();
}

describe("the funnel's counters, on a log small enough to count by hand", () => {
  const frames = framesOf(handCounted());

  it("counts every premise held by others, and passes on only the distinct ones on what the change alters", () => {
    expect(frames[0]?.changesCompared).toBe(1);
    expect(stageOf(frames[0], 0)).toEqual({
      considered: 4,
      settled: 2,
      passedOn: 2,
      usd: UNIT_USD.indexLookup,
    });
    expect(stageOf(frames[0], 1)).toEqual({ considered: 2, settled: 1, passedOn: 1, usd: 0 });
    // The contradiction waits at Clef until a conflict is opened for it.
    expect(stageOf(frames[0], 2)).toEqual({
      considered: 1,
      settled: 0,
      passedOn: 0,
      usd: UNIT_USD.clefCall,
    });
  });

  it("moves a comparison on when its conflict opens and when its probe is drafted, and ignores a conflict of another kind", () => {
    expect(frames.map((frame) => frame.at.slice(17, 23))).toEqual([
      "02.000",
      "03.000",
      "04.000",
      "06.000",
      "07.000",
      "09.000",
    ]);
    expect(stageOf(frames[1], 2)).toMatchObject({ settled: 0, passedOn: 1 });
    expect(stageOf(frames[1], 3)).toEqual({ considered: 1, settled: 0, passedOn: 0, usd: 0 });
    expect(stageOf(frames[2], 3)).toEqual({
      considered: 1,
      settled: 0,
      passedOn: 1,
      usd: 2 * UNIT_USD.probeDraft,
    });
  });

  it("lets Clef, not the lattice, settle what only Clef derived", () => {
    expect(stageOf(frames[3], 0)).toMatchObject({ considered: 8, settled: 4, passedOn: 4 });
    expect(stageOf(frames[3], 1)).toMatchObject({ considered: 4, settled: 1, passedOn: 3 });
    expect(stageOf(frames[3], 2)).toEqual({
      considered: 3,
      settled: 2,
      passedOn: 1,
      usd: 2 * UNIT_USD.clefCall,
    });
  });

  it("ends on the totals counted by hand", () => {
    const last = frames.at(-1);
    expect(last?.changesCompared).toBe(4);
    expect(stageOf(last, 0)).toMatchObject({ considered: 16, settled: 8, passedOn: 8 });
    expect(stageOf(last, 1)).toMatchObject({ considered: 8, settled: 5, passedOn: 3 });
    expect(stageOf(last, 2)).toMatchObject({ considered: 3, settled: 2, passedOn: 1 });
    expect(stageOf(last, 3)).toMatchObject({ considered: 1, settled: 0, passedOn: 1 });
  });
});

describe("the funnel's counters, across the subject tree", () => {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(2));
  const declare = (id: string, premises: Proposition[]): void => {
    b.emit({
      type: "IntentDeclared",
      entity: change(id),
      payload: {
        changeId: id,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal: "",
        footprint: [],
        premises,
        leaseId: "lse_1",
      },
    });
  };
  const derive = (id: string): AnyEvent =>
    b.emit({
      type: "EffectsDerived",
      entity: change(id),
      payload: {
        changeId: id,
        revision: 1,
        effects: [extracted(is("s.x", "freshness", "per-session"))],
        derivationRef: "",
      },
    });
  b.at(1);
  declare("P", [atMost("s", "freshness", "ttl")]);
  declare("Q", [atMost("s.x", "freshness", "per-request")]);
  declare("R", [atMost("t.x", "freshness", "ttl")]);
  declare("S", [atMost("s", "ordering", "strict")]);
  declare("Z", []);
  b.at(2);
  const first = derive("Z");
  // Keel sets Z against Q: that, and not anything in the derivation, is what says which premise Z contradicts.
  b.at(2.5).emit({
    type: "ConflictSuspected",
    entity: { kind: "conflict", id: "cfl_9" },
    payload: { conflictId: "cfl_9", kind: "semantic", parties: ["Q", "Z"] },
    causation: first,
  });
  b.at(3).emit({
    type: "ChangeWithdrawn",
    entity: change("P"),
    payload: { changeId: "P", by: "agt_1" },
  });
  b.at(4);
  derive("Z");
  const frames = framesOf(b.build());

  it("compares against a premise on an ancestor subject, and not against a cousin's or another predicate's", () => {
    // Four premises are held by others. Q's is on the subject and P's on its parent; R's is elsewhere and S's is about ordering.
    expect(stageOf(frames[0], 0)).toMatchObject({ considered: 4, settled: 2, passedOn: 2 });
    expect(stageOf(frames[0], 1)).toMatchObject({ considered: 2, settled: 1, passedOn: 1 });
  });

  it("stops counting a premise once its change is withdrawn", () => {
    // frames[1] is the conflict opening. By the second derivation P is gone, and nothing is set against Z this time.
    expect(stageOf(frames[2], 0)).toMatchObject({
      considered: 4 + 3,
      settled: 2 + 2,
      passedOn: 2 + 1,
    });
    expect(stageOf(frames[2], 1)).toMatchObject({ considered: 2 + 1, settled: 1 + 1, passedOn: 1 });
  });
});

describe.each([
  { fixture: "scenario 1", log: generateS1(42, "invalidate") },
  { fixture: "scenario 1, unruled", log: generateS1(42) },
  { fixture: "scenario 2", log: generateS2(42) },
  { fixture: "the swarm", log: generateSwarm(42) },
])("the funnel's counters in $fixture", ({ log }) => {
  const frames = framesOf(log);
  const count = (type: string): number => log.events.filter((event) => event.type === type).length;

  it("loses nothing between stages, at any instant", () => {
    const broken: string[] = [];
    let before: FunnelObservation | undefined;
    for (const frame of frames) {
      frame.stages.forEach((stage, index) => {
        const next = frame.stages[index + 1];
        const was = before?.stages[index];
        if (stage.settled + stage.passedOn > stage.considered)
          broken.push(`${frame.at} stage ${stage.stage}: more left than arrived`);
        if (next !== undefined && next.considered !== stage.passedOn)
          broken.push(
            `${frame.at} stage ${stage.stage}: passed on ${stage.passedOn}, but ${next.considered} arrived at the next`,
          );
        if (
          was !== undefined &&
          (stage.considered < was.considered ||
            stage.settled < was.settled ||
            stage.passedOn < was.passedOn ||
            stage.usd < was.usd)
        ) {
          broken.push(`${frame.at} stage ${stage.stage}: a total went down`);
        }
      });
      before = frame;
    }
    expect(broken).toEqual([]);
  });

  it("agrees with the events it was counted from", () => {
    const last = frames.at(-1);
    expect(frames.length).toBeGreaterThan(0);
    expect(last?.changesCompared).toBe(count("EffectsDerived"));
    expect(stageOf(last, 3)?.passedOn).toBe(count("ProbeDrafted"));
    // By the end nothing is left waiting on a model.
    expect(stageOf(last, 2)).toMatchObject({
      considered: (stageOf(last, 2)?.settled ?? 0) + (stageOf(last, 2)?.passedOn ?? 0),
    });
    expect(stageOf(last, 3)).toMatchObject({
      considered: stageOf(last, 3)?.passedOn ?? -1,
      settled: 0,
    });
  });
});
