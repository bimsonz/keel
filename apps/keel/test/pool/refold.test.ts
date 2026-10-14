// The feed's re-fold in the real Projector DO: a feed its receipts folded before
// they folded anchors and landings, written into the object's own storage, and
// the object woken again over it, so its constructor finds the feed as a deploy
// does. Nothing but the object's own alarm moves the re-fold.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  DECISION_INDEX,
  feedHead,
  foldViews,
  recordFeed,
  REFOLD,
  VIEWS,
  why,
} from "@keeltown/core/application/memory";
import type { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { Decisions, EntityStore } from "@keeltown/core/ports";
import { projectEvents, ruledConflict } from "@keeltown/testing";
import { Effect, Result } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { DecisionsRpc } from "../../src/adapters/driven/do-rpc/decisions.ts";
import { armedAlarms } from "../../src/adapters/driving/do/alarm.ts";
import { PROJECTOR_REFOLD, type ProjectorDO } from "../../src/adapters/driving/do/projector.ts";

/** How long a case waits for an alarm the platform may already be running. */
const WAIT = { timeout: 20_000, interval: 50 };
const FILE = "src/authz/check.ts";

type Store = (typeof EntityStore)["Service"];
type ProjectorStub = DurableObjectStub<ProjectorDO>;

/** A Projector of the case's own, so its feed holds only what the case writes. */
const freshProjector = (): ProjectorStub =>
  env.PROJECTOR.get(env.PROJECTOR.idFromName(`refold:${ulid()}`));

/** Runs `body` over the object's own store, inside it. */
const inStore = <A>(stub: ProjectorStub, body: (store: Store) => A) =>
  runInDurableObject(stub, (instance: ProjectorDO) =>
    instance["runtime"].runPromise(Effect.map(EntityStore, body)),
  );

/** Where the object's re-fold stands, and whether its step is armed. */
const standing = (stub: ProjectorStub) =>
  runInDurableObject(stub, (instance: ProjectorDO, state) =>
    instance["runtime"].runPromise(
      Effect.map(EntityStore, (store) => ({
        refolded: store.get(REFOLD.refolded.kind, REFOLD.refolded.id) ?? 0,
        until: store.get(REFOLD.until.kind, REFOLD.until.id),
        armed: armedAlarms(state.storage).some((armed) => armed.reason === PROJECTOR_REFOLD),
      })),
    ),
  );

/**
 * A conflict ruled for the premise, its holder landed after the ruling and
 * its subject anchored in `FILE`, as the Projector hears it.
 */
function ruledAndLanded() {
  const events = projectEvents();
  const ruled = ruledConflict(events);
  const arrivals: readonly EventEnvelope[] = [
    ruled.minted([FILE]),
    events.declared(ruled.holder, `agt_${ulid()}`, "Check permissions on every request"),
    events.declared(ruled.other, `agt_${ulid()}`, "Cache sessions for an hour"),
    events.started(ruled.holder),
    events.started(ruled.other),
    ...ruled.conflict,
    ruled.recorded("premise-holds"),
    ruled.resolved([ruled.other]),
    ...events.landing(ruled.holder, "e".repeat(40)),
  ];
  const landing = arrivals.find((event) => event.type === "ChangeLanded");
  if (landing === undefined) throw new Error("the holder never landed");
  return { project: events.project, ruled, arrivals, landing };
}

/**
 * Writes the feed into the object's store as a Projector before this one left
 * it: every arrival recorded and folded, but no anchor and no landing, and no
 * re-fold begun. Answers the feed's head.
 */
const predating = (stub: ProjectorStub, project: ProjectId, arrivals: readonly EventEnvelope[]) =>
  inStore(stub, (store) => {
    for (const event of arrivals)
      store.transaction(() => {
        recordFeed(store, event);
        foldViews(store, event);
      });
    store.transaction(() => {
      for (const kind of [DECISION_INDEX.anchor(project), VIEWS.landed])
        for (const { id } of store.list(kind)) store.remove(kind, id);
      store.remove(REFOLD.until.kind, REFOLD.until.id);
    });
    return feedHead(store);
  });

describe("the Projector's re-fold", () => {
  it("[projector.refold] a Projector woken over a feed that predates its anchors and landings arms its re-fold, its alarm levels it, and the file then answers why; a level Projector arms nothing", async () => {
    const stub = freshProjector();
    const { project, ruled, arrivals, landing } = ruledAndLanded();
    // Its first wake found an empty feed: nothing to re-fold, and nothing armed.
    expect(await standing(stub)).toEqual({ refolded: 0, until: 0, armed: false });
    const head = await predating(stub, project, arrivals);
    expect(head).toBe(arrivals.length);
    expect(await standing(stub)).toEqual({ refolded: 0, until: undefined, armed: false });

    // Woken again over that feed, as after a deploy: the constructor marks where the re-fold ends and arms its step, due at once.
    await evictDurableObject(stub);
    const woke = await standing(stub);
    expect(woke.until).toBe(head);
    // The platform may have run the step already.
    expect(woke.armed || woke.refolded === head).toBe(true);
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(await standing(stub)).toEqual({ refolded: head, until: head, armed: false });
    }, WAIT);

    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const atPath = yield* (yield* Decisions).atPath(project, FILE);
        const chain = yield* Effect.result(why(project, { kind: "path", path: FILE }));
        return { atPath, chain };
      }).pipe(Effect.provide(DecisionsRpc(() => stub))),
    );
    expect(read.atPath.map((d) => d.decision.id)).toEqual([ruled.decisionId]);
    const at = new Date(landing.at).toISOString();
    expect(
      Result.getOrThrow(read.chain).map((link) => [
        link.record.message.kind,
        link.record.id,
        link.record.at,
      ]),
    ).toContainEqual(["verdict", `${ruled.holder}.landed.${ruled.decisionId}`, at]);

    // Level, it arms nothing when it wakes again, and nor does a Projector whose feed is empty.
    await evictDurableObject(stub);
    expect(await standing(stub)).toEqual({ refolded: head, until: head, armed: false });
    expect(await standing(freshProjector())).toEqual({ refolded: 0, until: 0, armed: false });
  });
});
