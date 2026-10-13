import {
  FEED,
  FEED_INDEX_STEP,
  indexFeed,
  readFeed,
  recordFeed,
} from "@keeltown/core/application/memory";
import { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { EntityStore, type Stored } from "@keeltown/core/ports";
import { makeEntityStoreMemory } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 150, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/** A property of many reads takes a second alone and several in the whole suite under load. */
const PROPERTY_TIMEOUT = 60_000;

const decodeProject = Schema.decodeUnknownSync(ProjectId);
const PROJECTS = ["AA", "BB", "CC"].map((tail) =>
  decodeProject(`prj_01JZ8PT2C4E6G8J0M2N4Q6S8${tail}`),
);
const encode = Schema.encodeSync(EventEnvelope);
const position = (n: number) => String(n).padStart(12, "0");
const asStored = (event: EventEnvelope): Stored => JSON.parse(JSON.stringify(encode(event)));

/** The n-th arrival, in `project` or in none. */
const arrival = (n: number, project: ProjectId | undefined) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_01JZ8PT2C4E6G8J0M2N4${String(n).padStart(6, "0")}`,
    type: "ChangeStarted",
    entity: { kind: "change", id: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
    seq: n,
    at: 1_700_000_000_000 + n,
    dedupeKey: `change:chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0/c${n}/ChangeStarted#1`,
    ...(project === undefined ? {} : { project }),
    affected: [],
    notified: ["projector"],
    payload: { _tag: "ChangeStarted", changeId: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
  });

type Store = (typeof EntityStore)["Service"];
const read = (store: Store, cursor: string | undefined, limit: number, project?: ProjectId) =>
  Effect.runSync(Effect.provideService(readFeed(cursor, limit, project), EntityStore, store));
const idsOf = (page: { readonly events: readonly EventEnvelope[] }) =>
  page.events.map((event) => event.eventId);

/** Every event of `project`, read page by page until the cursor stops moving. */
function readOut(store: Store, project: ProjectId, limit: number) {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const page = read(store, cursor, limit, project);
    ids.push(...idsOf(page));
    cursors.push(page.cursor);
    if (page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return { ids, cursors };
}

describe("the feed read by project", () => {
  it(
    "[t3.feed-project] a project's page is the whole feed after the cursor, kept to that project and cut to the limit; its cursor is the last one returned when cut and the head otherwise; read to the end, every event of the project comes exactly once",
    () => {
      let cuts = 0;
      let caughtUp = 0;
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 60 }),
          fc.integer({ min: 0, max: 64 }),
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: 0, max: 2 }),
          (arrivals, after, limit, which) => {
            const store = makeEntityStoreMemory().service;
            const events = arrivals.map((p, index) => arrival(index + 1, PROJECTS[p]));
            for (const event of events) store.transaction(() => recordFeed(store, event));
            const project = PROJECTS[which];
            if (project === undefined) throw new Error("three projects");
            const head = events.length;

            // The model: the feed as an array, filtered.
            const mine = events.flatMap((event, index) =>
              index + 1 > after && event.project === project ? [{ event, at: index + 1 }] : [],
            );
            const cut = mine.length > limit;
            if (cut) cuts += 1;
            else caughtUp += 1;
            const expected = {
              ids: mine.slice(0, limit).map((each) => each.event.eventId),
              cursor: position(cut ? (mine[limit - 1]?.at ?? 0) : Math.max(head, after)),
            };
            const page = read(store, position(after), limit, project);
            expect({ ids: idsOf(page), cursor: page.cursor }).toEqual(expected);

            // Read to the end: each of the project's events once, in arrival order, and the cursor never goes back.
            const all = readOut(store, project, limit);
            expect(all.ids).toEqual(
              events.filter((event) => event.project === project).map((event) => event.eventId),
            );
            expect(all.cursors).toEqual(all.cursors.toSorted());
            expect(all.cursors.at(-1)).toBe(position(head));

            // A read that names no project is as it was.
            const whole = read(store, position(after), limit);
            expect(idsOf(whole)).toEqual(
              events.slice(after, after + limit).map((event) => event.eventId),
            );
          },
        ),
      );
      // The generator reaches both ends of the cursor rule.
      expect(cuts).toBeGreaterThan(0);
      expect(caughtUp).toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT,
  );

  it("[t3.feed-project] by hand: interleaved projects, a page cut and a page caught up", () => {
    const store = makeEntityStoreMemory().service;
    const [a, b] = PROJECTS;
    const events = [a, b, a, undefined, b, a, b].map((project, index) =>
      arrival(index + 1, project),
    );
    for (const event of events) store.transaction(() => recordFeed(store, event));
    if (a === undefined) throw new Error("a project");
    const ids = (...indexes: number[]) => indexes.map((index) => events[index]?.eventId);

    const cut = read(store, undefined, 2, a);
    const rest = read(store, cut.cursor, 2, a);
    const atHead = read(store, rest.cursor, 2, a);
    const beyond = read(store, position(40), 2, a);

    expect([idsOf(cut), cut.cursor]).toEqual([ids(0, 2), position(3)]);
    // Caught up: past the other project's last event, at the head.
    expect([idsOf(rest), rest.cursor]).toEqual([ids(5), position(7)]);
    expect(atHead).toEqual({ events: [], cursor: position(7) });
    // A cursor past the head is kept: the reader never goes back.
    expect(beyond).toEqual({ events: [], cursor: position(40) });
  });

  it("[t3.feed-index-backfill] a feed recorded before the index is indexed in steps: every read meanwhile is exact and never passes what is indexed, an arrival meanwhile keeps its place, and a second pass adds nothing", () => {
    const store = makeEntityStoreMemory().service;
    const [a, b] = PROJECTS;
    if (a === undefined || b === undefined) throw new Error("two projects");
    const total = 2 * FEED_INDEX_STEP + 7;
    const mine: string[] = [];
    let placed = 0;
    // As the feed was recorded before it kept an index: the entries, the head, and a label.
    for (let n = 1; n <= total; n += 1) {
      const project: ProjectId | undefined =
        n % 1000 === 0 || n > total - 3 ? a : n % 7 === 0 ? undefined : b;
      const event = arrival(n, project);
      store.put(FEED.kind, position(n), asStored(event));
      if (project === a) mine.push(event.eventId);
      if (project !== undefined) placed += 1;
    }
    store.put(FEED.head.kind, FEED.head.id, total);
    store.put(FEED.label, position(1000), "#1");
    const indexed = () => Number(store.get(FEED.indexed.kind, FEED.indexed.id) ?? 0);

    // The first read moves the index one step: it answers what is indexed and stops there, not at the head.
    const first = read(store, undefined, 500, a);
    expect(indexed()).toBe(FEED_INDEX_STEP);
    expect(idsOf(first)).toEqual(mine.slice(0, 5));
    expect(first.cursor).toBe(position(FEED_INDEX_STEP));
    expect(first.events[0]).toMatchObject({ label: "#1" });

    // An arrival while the index is behind is recorded at the head and indexed in its turn.
    const late = arrival(total + 1, a);
    store.transaction(() => recordFeed(store, late));
    expect(indexed()).toBe(2 * FEED_INDEX_STEP);

    // The reader's next page, from the cursor it was given, has the rest: nothing skipped, the late one last.
    const second = read(store, first.cursor, 500, a);
    expect(idsOf(second)).toEqual([...mine.slice(5), late.eventId]);
    expect(second.cursor).toBe(position(total + 1));
    expect(indexed()).toBe(total + 1);
    expect(readOut(store, a, 500).ids).toEqual([...mine, late.eventId]);

    // Level: another pass writes nothing, and the label is where it was.
    const rows = store.list(FEED.byProject).length;
    expect(store.transaction(() => indexFeed(store))).toBe(total + 1);
    expect(store.list(FEED.byProject).length).toBe(rows);
    expect(rows).toBe(placed + 1);
    expect(store.get(FEED.label, position(1000))).toBe("#1");
  });
});
