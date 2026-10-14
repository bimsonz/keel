import {
  foldViews,
  LANDINGS_KEPT,
  landedOnPath,
  recordFeed,
} from "@keeltown/core/application/memory";
import type { EventEnvelope } from "@keeltown/core/kernel";
import type { EntityStore } from "@keeltown/core/ports";
import { makeEntityStoreMemory, projectEvents } from "@keeltown/testing";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

type Store = (typeof EntityStore)["Service"];

const commitOf = (n: number) => n.toString(16).padStart(40, "e");
const changeOf = () => `chg_${ulid()}`;

/** Each event recorded on the feed and folded, as a receipt does. */
const live = (store: Store, events: readonly EventEnvelope[]) => {
  for (const event of events)
    store.transaction(() => {
      recordFeed(store, event);
      foldViews(store, event);
    });
};

/** The changes the Projector says landed on a path, newest first. */
const on = (store: Store, events: ReturnType<typeof projectEvents>, path: string) =>
  store.transaction(() => landedOnPath(store, events.project, path, 10)).map((v) => v.change.id);

describe("the Projector's landings by path", () => {
  it(`[why.landed-on] indexes a landing under each path its last derivation touched, the newest ${LANDINGS_KEPT} a path, newest first; a change that never lands, or one derived before paths were kept, is not indexed, and folding a landing again changes nothing`, () => {
    const store = makeEntityStoreMemory().service;
    const p = projectEvents();
    const landed: string[] = [];
    let last: EventEnvelope | undefined;
    for (let n = 1; n <= LANDINGS_KEPT + 2; n += 1) {
      const id = changeOf();
      landed.push(id);
      const landing = p.landing(id, commitOf(n), ["src/a.ts", `src/only-${n}.ts`]);
      last = landing.at(-1);
      live(store, [
        p.declared(id, `agt_${ulid()}`, `Rewrite a, take ${n}`),
        p.started(id),
        ...landing,
      ]);
    }
    // Derived on a.ts first, then again on c.ts alone: its last derivation is what landed.
    const rederived = changeOf();
    live(store, [
      p.declared(rederived, `agt_${ulid()}`, "Move the work to c"),
      p.started(rederived),
      p.derived(rederived, ["src/a.ts"]),
      ...p.landing(rederived, commitOf(90), ["src/c.ts"]),
    ]);
    // Derived on a.ts and never landed.
    const open = changeOf();
    live(store, [
      p.declared(open, `agt_${ulid()}`, "Still open"),
      p.started(open),
      p.derived(open, ["src/a.ts"]),
    ]);
    // Landed with no paths, as a derivation from before they were kept.
    const older = changeOf();
    live(store, [
      p.declared(older, `agt_${ulid()}`, "From before"),
      p.started(older),
      ...p.landing(older, commitOf(91)),
    ]);

    expect(on(store, p, "src/a.ts")).toEqual(landed.toReversed().slice(0, LANDINGS_KEPT));
    expect(on(store, p, "src/only-1.ts")).toEqual([landed[0]]);
    expect(on(store, p, "src/c.ts")).toEqual([rederived]);
    expect(on(store, p, "src/never.ts")).toEqual([]);

    // The newest landing folded again, as the feed's re-fold may: the rows read as they did.
    if (last !== undefined) store.transaction(() => foldViews(store, last));
    expect(on(store, p, "src/a.ts")).toEqual(landed.toReversed().slice(0, LANDINGS_KEPT));
  });
});
