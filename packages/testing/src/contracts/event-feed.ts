import { describe, expect, it } from "@effect/vitest";
import { EventEnvelope, Instant, ProjectId } from "@keeltown/core/kernel";
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

/** A change's event, as its DO would commit it, in `project` when given. Its eventId is how a case finds it on the feed. */
const event = (seq: number, project?: string): EventEnvelope => {
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
    ...(project === undefined ? {} : { project }),
  });
};

const decodeProject = Schema.decodeUnknownSync(ProjectId);
const freshProject = () => decodeProject(`prj_${ulid()}`);

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

const idsOf = (page: { readonly events: readonly EventEnvelope[] }) =>
  page.events.map((e) => e.eventId);

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

    it.live(
      "[feed.end] a read from `end` answers no events and the head, and reading on from that cursor answers what arrives after it and nothing from before, for the whole feed and for one project",
      () => {
        const harness = make();
        const [a, b] = [freshProject(), freshProject()];
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          const earlier = [event(1, a), event(2, b), event(3)];
          for (const e of earlier) yield* harness.arrive(e);
          const at = yield* head;
          const whole = yield* feed.read({ cursor: "end", waitSeconds: 0 });
          const mine = yield* feed.read({ cursor: "end", waitSeconds: 0, project: a });
          expect(whole).toEqual({ events: [], cursor: at });
          expect(mine).toEqual({ events: [], cursor: at });

          const later = [event(4, b), event(5, a), event(6), event(7, a)];
          for (const e of later) yield* harness.arrive(e);
          const on = yield* feed.read({ cursor: whole.cursor, waitSeconds: 0 });
          expect(idsOf(on)).toEqual(idsOf({ events: later }));
          const onMine = yield* feed.read({ cursor: mine.cursor, waitSeconds: 0, project: a });
          expect(idsOf(onMine)).toEqual([later[1]?.eventId, later[3]?.eventId]);
          // `end` moves with the feed.
          const again = yield* feed.read({ cursor: "end", waitSeconds: 0, limit: 1 });
          expect(again).toEqual({ events: [], cursor: yield* head });
          expect(again.cursor > whole.cursor).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[feed.end-waits] a waiting read from `end` is answered by the next arrival, and by nothing that was there before",
      () => {
        const harness = make();
        const a = freshProject();
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          const before = [event(1, a), event(2)];
          for (const e of before) yield* harness.arrive(e);
          const started = Date.now();
          const waiting = yield* Effect.forkChild(feed.read({ cursor: "end", waitSeconds: 8 }));
          const mine = yield* Effect.forkChild(
            feed.read({ cursor: "end", waitSeconds: 8, project: a }),
          );
          yield* Effect.sleep("200 millis");
          const arrived = event(3, a);
          yield* harness.arrive(arrived);
          expect(idsOf(yield* Fiber.join(waiting))).toEqual([arrived.eventId]);
          expect(idsOf(yield* Fiber.join(mine))).toEqual([arrived.eventId]);
          expect(Date.now() - started).toBeLessThan(6_000);
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
      "[feed.project] a read by project answers only that project's events, in arrival order: its cursor is the last one returned when the limit cut the page, and past every other project's events once it is caught up",
      () => {
        const harness = make();
        const [a, b] = [freshProject(), freshProject()];
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          const from = yield* head;
          const arrived = [
            event(1, a),
            event(2, b),
            event(3, a),
            event(4),
            event(5, b),
            event(6, a),
            event(7, b),
          ];
          for (const e of arrived) yield* harness.arrive(e);
          const ids = (...indexes: number[]) => indexes.map((index) => arrived[index]?.eventId);

          const cut = yield* feed.read({ cursor: from, limit: 2, waitSeconds: 0, project: a });
          // Cut after the project's second event: the whole feed read on from that cursor starts at the next arrival.
          const afterCut = yield* feed.read({ cursor: cut.cursor, waitSeconds: 0 });
          const rest = yield* feed.read({
            cursor: cut.cursor,
            limit: 2,
            waitSeconds: 0,
            project: a,
          });
          // Caught up: the cursor is at the head, past the other project's last event.
          const beyond = yield* feed.read({ cursor: rest.cursor, waitSeconds: 0 });
          const again = yield* feed.read({ cursor: rest.cursor, waitSeconds: 0, project: a });
          const others = yield* feed.read({ cursor: from, waitSeconds: 0, project: b });

          expect(idsOf(cut)).toEqual(ids(0, 2));
          expect(idsOf(afterCut)).toEqual(ids(3, 4, 5, 6));
          expect(idsOf(rest)).toEqual(ids(5));
          expect(beyond.events).toEqual([]);
          expect(again).toEqual({ events: [], cursor: rest.cursor });
          expect(idsOf(others)).toEqual(ids(1, 4, 6));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[feed.project] a waiting read by project is not answered by another project's arrival, and is by its own",
      () => {
        const harness = make();
        const [a, b] = [freshProject(), freshProject()];
        return Effect.gen(function* () {
          const feed = yield* EventFeed;
          const from = yield* head;
          const started = Date.now();
          const waiting = yield* Effect.forkChild(
            feed.read({ cursor: from, waitSeconds: 20, project: a }),
          );
          yield* Effect.sleep("200 millis");
          yield* harness.arrive(event(1, b));
          yield* Effect.sleep("500 millis");
          const mine = event(2, a);
          yield* harness.arrive(mine);
          const page = yield* Fiber.join(waiting);
          // Answered by its own project's event, and so only after it arrived.
          expect(page.events.map((e) => e.eventId)).toEqual([mine.eventId]);
          expect(Date.now() - started).toBeGreaterThanOrEqual(650);
          expect(Date.now() - started).toBeLessThan(10_000);
        }).pipe(Effect.provide(harness.layer));
      },
    );

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
