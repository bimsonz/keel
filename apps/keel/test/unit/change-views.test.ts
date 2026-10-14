import { describe, expect, it } from "@effect/vitest";
import { ChangeEvent, replayChange } from "@keeltown/core/domain/coordination";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { type ChangeListRead, ProjectViews } from "@keeltown/core/ports";
import { makeProjectViewsMemory, projectEvents } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 200, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const STATES = ["declared", "working", "withdrawn"] as const;
type Ending = (typeof STATES)[number];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let made = 0;
/** Distinct ids without randomness, so a seeded run replays exactly. */
const nextId = (prefix: string) => {
  made += 1;
  let n = made;
  let tail = "";
  for (let i = 0; i < 26; i += 1) {
    tail = (CROCKFORD[n % 32] ?? "0") + tail;
    n = Math.floor(n / 32);
  }
  return `${prefix}_${tail}`;
};

/** The events that leave a change in `ending`. */
const lifecycle = (events: ReturnType<typeof projectEvents>, ending: Ending) => {
  const changeId = nextId("chg");
  const declared = events.declared(changeId, nextId("agt"), "a goal");
  if (ending === "declared") return [declared];
  if (ending === "working") return [declared, events.started(changeId)];
  return [declared, events.withdrawn(changeId)];
};

const read = (memory: ReturnType<typeof makeProjectViewsMemory>, request: ChangeListRead) =>
  Effect.runSync(
    ProjectViews.use((views) => views.changes(request)).pipe(Effect.provide(memory.layer)),
  );

describe("the Projector's change list", () => {
  it("[b12.change-list] walking the pages yields the project's changes in the asked state, newest #n first, each once", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ mine: fc.boolean(), ending: fc.constantFrom(...STATES) }), {
          maxLength: 24,
        }),
        fc.integer({ min: 1, max: 8 }),
        fc.option(fc.constantFrom(...STATES), { nil: undefined }),
        (changes, limit, state) => {
          const memory = makeProjectViewsMemory();
          const mine = projectEvents();
          const theirs = projectEvents();
          const expected: number[] = [];
          for (const change of changes) {
            const events = lifecycle(change.mine ? mine : theirs, change.ending);
            for (const event of events) Effect.runSync(memory.arrive(event));
            if (change.mine) {
              const number = changes.filter((c) => c.mine).indexOf(change) + 1;
              if (state === undefined || change.ending === state) expected.unshift(number);
            }
          }
          const walked: number[] = [];
          let cursor: number | undefined;
          for (let pages = 0; pages <= changes.length + 1; pages += 1) {
            const page = read(memory, { project: mine.project, state, cursor, limit });
            walked.push(...page.items.map((item) => item.number));
            expect(page.items.length).toBeLessThanOrEqual(limit);
            cursor = page.nextCursor;
            if (cursor === undefined) break;
          }
          expect(walked).toEqual(expected.toSorted((a, b) => b - a));
        },
      ),
    );
  });

  it("[b12.change-list] holds the state the change machine folds from the same events, at every step", () => {
    const memory = makeProjectViewsMemory();
    const events = projectEvents();
    const changeId = nextId("chg");
    const log: EventEnvelope[] = [
      events.declared(changeId, nextId("agt"), "a goal"),
      events.started(changeId),
      events.withdrawn(changeId),
    ];
    const seen = log.map((event, at) => {
      Effect.runSync(memory.arrive(event));
      const replayed = replayChange(
        log.slice(0, at + 1).map((e) => ({
          at: e.at,
          payload: Schema.decodeUnknownSync(ChangeEvent)(e.payload),
        })),
      );
      return [read(memory, { project: events.project }).items[0]?.state, replayed?.state];
    });

    expect(seen).toEqual([
      ["declared", "declared"],
      ["working", "working"],
      ["withdrawn", "withdrawn"],
    ]);
    expect(memory.skipped).toEqual([]);
  });

  it("[b31.stance-unfolded] a change's stances on a precedent leave its view as it was, and nothing is skipped", () => {
    const memory = makeProjectViewsMemory();
    const events = projectEvents();
    const changeId = nextId("chg");
    const decisionId = nextId("dec");
    Effect.runSync(memory.arrive(events.declared(changeId, nextId("agt"), "a goal")));
    const before = read(memory, { project: events.project }).items;
    for (const payload of [
      { _tag: "PrecedentSurfaced", decisionId, changeId },
      { _tag: "PrecedentDistinguished", decisionId, changeId, distinction: "another path" },
    ])
      Effect.runSync(memory.arrive(events.of({ kind: "change", id: changeId }, payload)));

    expect(read(memory, { project: events.project }).items).toEqual(before);
    expect(memory.skipped).toEqual([]);
  });
});
