import { describe, expect, it } from "@effect/vitest";
import {
  readInbox,
  recordDelivery,
  RESERVATION_TTL_MS,
  reserveChange,
} from "@keeltown/core/application/identity";
import { AgentId, EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore } from "@keeltown/core/ports";
import { makeEventOutboxMemory, makeIdsMemory, makeManualClock } from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

/** One agent's AgentSession state, in memory, on a clock the test moves. */
function session() {
  const clock = makeManualClock();
  const layer = Layer.mergeAll(makeEventOutboxMemory().layer, makeIdsMemory().layer, clock.layer);
  return { clock, layer };
}

describe("reserveChange", () => {
  it.effect(
    "[b11.reserve] keeps a key's change id for 24 h, refuses it for another body, and mints anew after",
    () => {
      const { clock, layer } = session();
      return Effect.gen(function* () {
        const first = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f1" });
        const retried = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f1" });
        const other = yield* reserveChange(agentId, { idempotencyKey: "k2", fingerprint: "f1" });
        const conflict = yield* Effect.exit(
          reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f2" }),
        );
        clock.advance(RESERVATION_TTL_MS - 1);
        const stillHeld = yield* reserveChange(agentId, {
          idempotencyKey: "k1",
          fingerprint: "f1",
        });
        clock.advance(1);
        const expired = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f2" });
        const renewed = yield* reserveChange(agentId, { idempotencyKey: "k1", fingerprint: "f2" });

        expect(retried).toBe(first);
        expect(other).not.toBe(first);
        expect(Exit.isFailure(conflict) && JSON.stringify(conflict.cause)).toContain(
          "IdempotencyConflict",
        );
        expect(stillHeld).toBe(first);
        expect(expired).not.toBe(first);
        expect(renewed).toBe(expired);
      }).pipe(Effect.provide(layer));
    },
  );
});

const delivered = (n: number) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_01JZ8PT2C4E6G8J0M2N4Q6S8${String(n).padStart(2, "0")}`,
    type: "ChangeBounced",
    entity: { kind: "change", id: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
    seq: n,
    at: 1_700_000_000_000 + n,
    dedupeKey: `change:chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0/c${n}/ChangeBounced#1`,
    affected: [],
    notified: [`agent:${agentId}`],
    payload: { _tag: "ChangeBounced" },
  });

describe("readInbox", () => {
  it.effect("pages the inbox oldest first after a cursor, and an empty page keeps the cursor", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const empty = yield* readInbox(undefined);
      for (const n of [1, 2, 3]) recordDelivery(store, delivered(n));
      const all = yield* readInbox(empty.cursor);
      const later = yield* readInbox(all.cursor);
      recordDelivery(store, delivered(4));
      const fourth = yield* readInbox(all.cursor);

      expect(empty.notices).toEqual([]);
      expect(all.notices.map((notice) => notice.id)).toEqual(
        [1, 2, 3].map((n) => delivered(n).eventId),
      );
      expect(all.notices[0]).toMatchObject({
        kind: "ChangeBounced",
        title: "Change bounced: chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
        ref: "change:chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      });
      expect(later).toEqual({ notices: [], cursor: all.cursor });
      expect(fourth.notices.map((notice) => notice.id)).toEqual([delivered(4).eventId]);
    }).pipe(Effect.provide(makeEventOutboxMemory().layer)),
  );
});
