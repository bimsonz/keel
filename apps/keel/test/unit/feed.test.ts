import { describe, expect, it } from "@effect/vitest";
import { readFeed, recordFeed } from "@keeltown/core/application/memory";
import { EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore } from "@keeltown/core/ports";
import { makeEventOutboxMemory } from "@keeltown/testing";
import { Effect, Schema } from "effect";

const arrived = (n: number) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_01JZ8PT2C4E6G8J0M2N4Q6S8${String(n).padStart(2, "0")}`,
    type: "ChangeStarted",
    entity: { kind: "change", id: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
    seq: n,
    at: 1_700_000_000_000 + n,
    dedupeKey: `change:chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0/c${n}/ChangeStarted#1`,
    affected: [],
    notified: ["projector"],
    payload: { _tag: "ChangeStarted", changeId: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
  });

describe("the Projector's feed", () => {
  it.effect("pages every recorded event in arrival order after a cursor, at most `limit`", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const empty = yield* readFeed(undefined, 2);
      for (const n of [1, 2, 3]) recordFeed(store, arrived(n));
      const first = yield* readFeed(empty.cursor, 2);
      const rest = yield* readFeed(first.cursor, 2);
      const after = yield* readFeed(rest.cursor, 2);

      expect(empty).toEqual({ events: [], cursor: "000000000000" });
      expect(first.events).toEqual([arrived(1), arrived(2)]);
      expect(first.cursor).toBe("000000000002");
      expect(rest.events).toEqual([arrived(3)]);
      expect(after).toEqual({ events: [], cursor: rest.cursor });
    }).pipe(Effect.provide(makeEventOutboxMemory().layer)),
  );
});

const PROJECT_A = "prj_01JZ8PT2C4E6G8J0M2N4Q6S8AA";
const PROJECT_B = "prj_01JZ8PT2C4E6G8J0M2N4Q6S8BB";
let minted = 0;

/** An event of `type` in `project` (or none), whose payload names `fields`. */
const creating = (
  type: string,
  project: string | undefined,
  fields: Readonly<Record<string, string>>,
) => {
  minted += 1;
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_01JZ8PT2C4E6G8J0M2N4Q7${String(minted).padStart(4, "0")}`,
    type,
    entity: { kind: "subject", id: "sub_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
    seq: minted,
    at: 1_700_000_000_000 + minted,
    dedupeKey: `subject:sub_01JZ8PT2C4E6G8J0M2N4Q6S8V0/c${minted}/${type}#1`,
    ...(project === undefined ? {} : { project }),
    affected: [],
    notified: ["projector"],
    payload: { _tag: type, ...fields },
  });
};

/** Records each event, then answers the labels the feed gives them, in order. */
const labelsOf = (events: readonly EventEnvelope[]) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const start = (yield* readFeed(undefined, 500)).cursor;
    for (const event of events) recordFeed(store, event);
    return (yield* readFeed(start, 500)).events.map((entry) => entry.label);
  });

describe("the Projector's short labels", () => {
  it.effect(
    "[b12.labels] numbers what each project creates, per kind, on its creating event only",
    () =>
      Effect.gen(function* () {
        const labels = yield* labelsOf([
          creating("IntentDeclared", PROJECT_A, { changeId: "chg_1" }),
          creating("ConflictSuspected", PROJECT_A, { conflictId: "cfl_1" }),
          creating("ConflictSuspected", PROJECT_A, { conflictId: "cfl_2" }),
          creating("ConflictSuspected", PROJECT_B, { conflictId: "cfl_3" }),
          creating("ConflictProven", PROJECT_A, { conflictId: "cfl_1" }),
          creating("DecisionRecorded", PROJECT_A, { decisionId: "dec_1" }),
          creating("GuardAdmitted", PROJECT_A, { guardId: "grd_1" }),
          creating("EscalationRaised", PROJECT_A, { escalationId: "esc_1" }),
          creating("ProbeDrafted", PROJECT_A, { probeId: "prb_1" }),
          creating("ProbeDiscarded", PROJECT_A, { probeId: "prb_1", reason: "unstable" }),
          creating("ProbeDiscarded", PROJECT_A, { probeId: "prb_2", reason: "draft-failed" }),
          creating("IntentDeclared", PROJECT_B, { changeId: "chg_2" }),
          creating("IntentDeclared", undefined, { changeId: "chg_3" }),
        ]);

        expect(labels).toEqual([
          "#1",
          "C-1",
          "C-2",
          "C-1",
          undefined,
          "D-1",
          "G-1",
          "E-1",
          "P-1",
          undefined,
          "P-2",
          "#1",
          undefined,
        ]);
      }).pipe(Effect.provide(makeEventOutboxMemory().layer)),
  );

  it.effect(
    "[b12.labels-replay] gives a thing its label once, however often its creation arrives",
    () =>
      Effect.gen(function* () {
        const labels = yield* labelsOf([
          creating("ConflictSuspected", PROJECT_A, { conflictId: "cfl_1" }),
          creating("ConflictSuspected", PROJECT_A, { conflictId: "cfl_1" }),
          creating("ConflictSuspected", PROJECT_A, { conflictId: "cfl_2" }),
        ]);

        expect(labels).toEqual(["C-1", "C-1", "C-2"]);
      }).pipe(Effect.provide(makeEventOutboxMemory().layer)),
  );
});
