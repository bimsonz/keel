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
