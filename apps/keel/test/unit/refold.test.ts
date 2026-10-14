import {
  foldViews,
  recordFeed,
  REFOLD,
  refoldFeed,
  refoldUntil,
  type RefoldStep,
} from "@keeltown/core/application/memory";
import type { EventEnvelope } from "@keeltown/core/kernel";
import type { EntityStore, Stored } from "@keeltown/core/ports";
import { makeEntityStoreMemory, projectEvents, ruledConflict } from "@keeltown/testing";
import * as fc from "fast-check";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 50, ...(seed === undefined ? {} : { seed: Number(seed) }) });

type Store = (typeof EntityStore)["Service"];
type Memory = ReturnType<typeof makeEntityStoreMemory>;

const commitOf = (n: number) => n.toString(16).padStart(40, "e");
const agent = () => `agt_${ulid()}`;

/**
 * A feed of two projects as the Projector hears it: subjects minted with
 * their anchors, changes declared, started and landed, and a conflict to its
 * ruling and resolution.
 */
function feedOf() {
  const mine = projectEvents();
  const theirs = projectEvents();
  const ruled = ruledConflict(mine);
  const elsewhere = ruledConflict(theirs, undefined, "billing.invoices");
  return [
    ruled.minted(["src/authz/check.ts", "src/authz/cache.ts"]),
    mine.declared(ruled.holder, agent(), "Check permissions on every request"),
    mine.declared(ruled.other, agent(), "Cache sessions for an hour"),
    mine.started(ruled.holder),
    ...ruled.conflict,
    ruled.recorded("premise-holds"),
    ruled.resolved([ruled.other]),
    ...mine.landing(ruled.holder, commitOf(1)),
    elsewhere.minted(["src/billing.ts", "src/authz/check.ts"]),
    theirs.declared(elsewhere.other, agent(), "Invoice monthly"),
    theirs.started(elsewhere.other),
    ...theirs.landing(elsewhere.other, commitOf(2)),
  ];
}

/** Each event recorded on the feed and folded, as a receipt does. */
const live = (store: Store, events: readonly EventEnvelope[]) => {
  for (const event of events)
    store.transaction(() => {
      recordFeed(store, event);
      foldViews(store, event);
    });
};

/** Each event recorded on the feed and folded into nothing. */
const recorded = (store: Store, events: readonly EventEnvelope[]) => {
  for (const event of events) store.transaction(() => recordFeed(store, event));
};

/** The re-fold from where it stands to level, a transaction a step: the steps it took. */
const refoldAll = (store: Store, step?: number): RefoldStep[] => {
  store.transaction(() => refoldUntil(store));
  const steps: RefoldStep[] = [];
  for (let n = 0; n < 1_000; n += 1) {
    const taken = store.transaction(() => refoldFeed(store, step));
    steps.push(taken);
    if (taken.level) break;
  }
  return steps;
};

const kindOf = (key: string) => key.slice(0, key.indexOf("\u0000"));
/** Whether a row is one the re-fold writes: an anchor or a landing. */
const isRefolded = (key: string) =>
  kindOf(key).startsWith("decision-anchor:") || kindOf(key) === "change-landed";

/** The rows the re-fold writes, the anchors and the landings, in key order. */
const refoldedRows = (memory: Memory): [string, Stored][] =>
  [...memory.rows().entries()]
    .filter(([key]) => isRefolded(key))
    .toSorted(([a], [b]) => (a < b ? -1 : 1));

/** Every row there is, in key order. */
const allRows = (memory: Memory): [string, Stored][] =>
  [...memory.rows().entries()].toSorted(([a], [b]) => (a < b ? -1 : 1));

const mark = (memory: Memory) => memory.service.get(REFOLD.refolded.kind, REFOLD.refolded.id);

describe("the feed's re-fold", () => {
  it("[projector.refold] a feed recorded with no folds and re-folded to level holds the anchors and landings a feed folded as it arrived holds, and re-folding a folded feed moves none of them", () => {
    const events = feedOf();
    const folded = makeEntityStoreMemory();
    const bare = makeEntityStoreMemory();
    live(folded.service, events);
    recorded(bare.service, events);
    const expected = refoldedRows(folded);
    expect(expected.map(([key]) => kindOf(key))).toEqual([
      "change-landed",
      "change-landed",
      expect.stringMatching(/^decision-anchor:/),
      expect.stringMatching(/^decision-anchor:/),
      expect.stringMatching(/^decision-anchor:/),
      expect.stringMatching(/^decision-anchor:/),
    ]);
    expect(refoldedRows(bare)).toEqual([]);

    expect(refoldAll(bare.service)).toEqual([{ from: 0, to: events.length, level: true }]);
    expect(refoldedRows(bare)).toEqual(expected);
    // A position the receipt folded and the re-fold folds again reads as it did.
    expect(refoldAll(folded.service)).toEqual([{ from: 0, to: events.length, level: true }]);
    expect(refoldedRows(folded)).toEqual(expected);
  });

  it("[projector.refold] runs only the anchors' and the landings' folds: a re-folded feed of changes, a conflict and its ruling gains no change, summary, conflict or decision row", () => {
    const events = feedOf();
    const bare = makeEntityStoreMemory();
    recorded(bare.service, events);
    const before = allRows(bare);
    refoldAll(bare.service);
    const after = allRows(bare);
    const kept = new Set(before.map(([key]) => key));

    const added = after
      .filter(([key]) => !kept.has(key))
      .map(([key]) => kindOf(key).replace(/:.*$/, ":"));
    expect([...new Set(added)]).toEqual([
      "change-landed",
      "decision-anchor:",
      "feed-refold-until",
      "feed-refolded",
    ]);
    // What the feed held is as it was.
    expect(after.filter(([key]) => kept.has(key))).toEqual(before);
  });

  it("[projector.refold] stops where the feed ended when it began: a subject minted after that is left to its receipt, the re-fold answers level, and a step more does nothing", () => {
    const events = feedOf();
    const after = projectEvents();
    const late = ruledConflict(after).minted(["src/late.ts"]);
    const bare = makeEntityStoreMemory();
    recorded(bare.service, events);
    expect(bare.service.transaction(() => refoldUntil(bare.service))).toEqual({
      refolded: 0,
      until: events.length,
    });
    // Recorded after `until`, and here folded by nothing.
    recorded(bare.service, [late]);

    expect(refoldAll(bare.service)).toEqual([{ from: 0, to: events.length, level: true }]);
    expect(bare.service.get(`decision-anchor:${after.project}`, "src/late.ts")).toBeUndefined();
    const rows = allRows(bare);
    expect(bare.service.transaction(() => refoldFeed(bare.service))).toEqual({
      from: events.length,
      to: events.length,
      level: true,
    });
    expect(allRows(bare)).toEqual(rows);
    expect(bare.service.transaction(() => refoldUntil(bare.service))).toEqual({
      refolded: events.length,
      until: events.length,
    });
  });

  it("[projector.refold] a step that dies part way commits nothing, its mark among it, and the re-fold run again reaches the rows of one never interrupted", () => {
    const events = feedOf();
    const whole = makeEntityStoreMemory();
    recorded(whole.service, events);
    refoldAll(whole.service);
    const bare = makeEntityStoreMemory();
    recorded(bare.service, events);
    bare.service.transaction(() => refoldUntil(bare.service));
    bare.service.transaction(() => refoldFeed(bare.service, 4));
    expect(mark(bare)).toBe(4);
    const settled = allRows(bare);
    // The second of the step's writes of the re-fold's rows fails.
    let writes = 0;
    const failing: Store = {
      ...bare.service,
      put: (kind, id, value) => {
        if (isRefolded(`${kind}\u0000${id}`)) {
          writes += 1;
          if (writes === 2) throw new Error("storage went away");
        }
        bare.service.put(kind, id, value);
      },
    };

    expect(() => failing.transaction(() => refoldFeed(failing))).toThrow("storage went away");
    expect(writes).toBe(2);
    expect(mark(bare)).toBe(4);
    expect(allRows(bare)).toEqual(settled);
    refoldAll(bare.service);
    expect(refoldedRows(bare)).toEqual(refoldedRows(whole));
    expect(mark(bare)).toBe(events.length);
  });

  it("[projector.refold] in steps of any size the re-fold reaches the rows one step reaches, each step from where the last ended and level only at the end", () => {
    const events = feedOf();
    const whole = makeEntityStoreMemory();
    recorded(whole.service, events);
    refoldAll(whole.service);
    const expected = refoldedRows(whole);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: events.length + 2 }), (step) => {
        const bare = makeEntityStoreMemory();
        recorded(bare.service, events);
        const steps = refoldAll(bare.service, step);

        expect(refoldedRows(bare)).toEqual(expected);
        expect(steps.map(({ from }) => from)).toEqual(
          steps.map((_, n) => Math.min(n * step, events.length)),
        );
        expect(steps.map(({ to }) => to)).toEqual(
          steps.map((_, n) => Math.min((n + 1) * step, events.length)),
        );
        expect(steps.map(({ level }) => level)).toEqual(
          steps.map((_, n) => n === steps.length - 1),
        );
        expect(steps).toHaveLength(Math.ceil(events.length / step));
      }),
    );
  });

  it("[projector.refold] by hand: steps of 2 over a feed of 7 positions", () => {
    const events = feedOf().slice(0, 7);
    const whole = makeEntityStoreMemory();
    recorded(whole.service, events);
    refoldAll(whole.service);
    const bare = makeEntityStoreMemory();
    recorded(bare.service, events);

    expect(refoldAll(bare.service, 2)).toEqual([
      { from: 0, to: 2, level: false },
      { from: 2, to: 4, level: false },
      { from: 4, to: 6, level: false },
      { from: 6, to: 7, level: true },
    ]);
    expect(refoldedRows(bare)).toEqual(refoldedRows(whole));
    expect(refoldedRows(bare)).not.toEqual([]);
  });
});
