import { describe, expect, it } from "@effect/vitest";
import { EventEnvelope, Instant } from "@keeltown/core/kernel";
import { EventFeed } from "@keeltown/core/ports";
import { Effect, Fiber, type Layer, Schema } from "effect";

/**
 * What the `EventFeed` suite needs beside the port: a way to make an event
 * arrive, as a committing object's outbox delivers it. A real feed is shared
 * and never empty, so every case reads from the head it finds, not the start.
 */
export interface EventFeedHarness {
  readonly layer: Layer.Layer<EventFeed>;
  readonly arrive: (event: EventEnvelope) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

/** A change's event, as its DO would commit it. Its eventId is how a case finds it on the feed. */
const event = (seq: number): EventEnvelope => {
  const entity = { kind: "change", id: `chg_${ulid()}` };
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_${ulid()}`,
    type: "ChangeBounced",
    entity,
    seq,
    at: Instant(Date.UTC(2026, 9, 11)),
    dedupeKey: `change:${entity.id}/feed-contract/ChangeBounced#${seq}`,
    affected: [],
    notified: [],
    payload: { _tag: "ChangeBounced" },
  });
};

/** The feed's head: read on until a page comes back empty. */
const head = Effect.gen(function* () {
  const feed = yield* EventFeed;
  let page = yield* feed.read({ waitSeconds: 0, limit: 500 });
  while (page.events.length > 0) {
    page = yield* feed.read({ cursor: page.cursor, waitSeconds: 0, limit: 500 });
  }
  return page.cursor;
});

const POSITION = /^\d{12}$/;

export function describeEventFeedContract(adapter: string, make: () => EventFeedHarness) {
  describe(`EventFeed contract: ${adapter}`, () => {
    it.live("[feed.after-cursor] answers the events after the cursor, in arrival order", () => {
      const harness = make();
      return Effect.gen(function* () {
        const feed = yield* EventFeed;
        const from = yield* head;
        const arrived = [event(1), event(2), event(3)];
        for (const e of arrived) yield* harness.arrive(e);
        const page = yield* feed.read({ cursor: from, waitSeconds: 0 });
        expect(page.events.map((e) => e.eventId)).toEqual(arrived.map((e) => e.eventId));
        expect(page.cursor).toMatch(POSITION);
        expect(page.cursor > from).toBe(true);
        const after = yield* feed.read({ cursor: page.cursor, waitSeconds: 0 });
        expect(after.events).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[feed.limit] answers at most `limit` events, and the rest from the cursor it gave",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          const from = yield* head;
          const arrived = [event(1), event(2), event(3)];
          for (const e of arrived) yield* harness.arrive(e);
          const first = yield* feed.read({ cursor: from, limit: 2, waitSeconds: 0 });
          expect(first.events.map((e) => e.eventId)).toEqual(
            arrived.slice(0, 2).map((e) => e.eventId),
          );
          const rest = yield* feed.read({ cursor: first.cursor, limit: 2, waitSeconds: 0 });
          expect(rest.events.map((e) => e.eventId)).toEqual([arrived[2]?.eventId]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[feed.cursor-always] answers a cursor on every page, the one it was given at the head",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          expect((yield* feed.read({ waitSeconds: 0, limit: 1 })).cursor).toMatch(POSITION);
          const at = yield* head;
          expect(at).toMatch(POSITION);
          const page = yield* feed.read({ cursor: at, waitSeconds: 0 });
          expect(page).toEqual({ events: [], cursor: at });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[feed.wait] answers a waiting read as soon as an event arrives", () => {
      const harness = make();
      return Effect.gen(function* () {
        const feed = yield* EventFeed;
        const from = yield* head;
        const started = Date.now();
        const waiting = yield* Effect.forkChild(feed.read({ cursor: from, waitSeconds: 20 }));
        yield* Effect.sleep("200 millis");
        const arrived = event(1);
        yield* harness.arrive(arrived);
        const page = yield* Fiber.join(waiting);
        expect(page.events.map((e) => e.eventId)).toContain(arrived.eventId);
        expect(Date.now() - started).toBeLessThan(10_000);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[feed.deadline] answers an empty page, keeping the cursor, when the wait runs out",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          const from = yield* head;
          const started = Date.now();
          const page = yield* feed.read({ cursor: from, waitSeconds: 1 });
          expect(Date.now() - started).toBeGreaterThanOrEqual(900);
          expect(page).toEqual({ events: [], cursor: from });
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
