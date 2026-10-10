// The WorkspacePool's use-cases over in-memory ports: real git objects in the
// code host, one transaction covering state and outbox, sequential ids.
import { describe, expect, it } from "@effect/vitest";
import {
  collectOnChangeEnd,
  collectWorkspaces,
  configurePool,
  grantWorkspace,
  GRANT_TTL_SECONDS,
  poolStatus,
  refillPool,
  releaseWorkspace,
} from "@keeltown/core/application/coordination";
import { ChangeId, Instant, type WorkspaceId } from "@keeltown/core/kernel";
import { Clock, CodeHost, EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
} from "@keeltown/testing";
import { Clock as EffectClock, Deferred, Effect, Fiber, Layer, Schema } from "effect";

const MIRROR = { namespace: "keel-ws-00", name: "mirror" };
const PROJECT = "prj_00000000000000000000000001";
const holder = (n: number) =>
  Schema.decodeUnknownSync(ChangeId)(`chg_${String(n).padStart(26, "0")}`);

/**
 * A clock that yields before every reading. `commit` reads the clock before
 * its transaction, so concurrent grants interleave between choosing a slot
 * and committing it: the adversarial schedule the in-transaction check exists for.
 */
const yieldingClock = Layer.succeed(
  Clock,
  Clock.of({
    now: Effect.yieldNow.pipe(
      Effect.andThen(EffectClock.currentTimeMillis),
      Effect.map((ms) => Instant(ms)),
    ),
  }),
);

/** The pool's ports, with an optional gate every fork waits on. */
function pool(options: { readonly forkGate?: Deferred.Deferred<void> } = {}) {
  const host = makeCodeHostMemory();
  const outbox = makeEventOutboxMemory();
  const gate = options.forkGate;
  const gated =
    gate === undefined
      ? host.layer
      : Layer.effect(
          CodeHost,
          Effect.gen(function* () {
            const inner = yield* CodeHost;
            return CodeHost.of({
              ...inner,
              fork: (source, target) =>
                Deferred.await(gate).pipe(Effect.andThen(inner.fork(source, target))),
            });
          }),
        ).pipe(Layer.provideMerge(host.layer));
  return Layer.mergeAll(gated, outbox.layer, makeIdsMemory().layer, yieldingClock);
}

/** The mirror the pool forks from, with one commit on main. */
const seedMirror = Effect.gen(function* () {
  const host = yield* CodeHost;
  const fixture = yield* CodeHostFixture;
  yield* host.create(MIRROR);
  return yield* fixture.commit(MIRROR, "refs/heads/main", { "README.md": "forge-lite\n" });
});

/** An event payload's type. */
const tagOf = (payload: unknown): string =>
  typeof payload === "object" && payload !== null && "_tag" in payload ? String(payload._tag) : "";

const eventsOf = (id: WorkspaceId) =>
  Effect.gen(function* () {
    const outbox = yield* EventOutbox;
    return outbox.log({ kind: "workspace", id }).map((e) => e.payload);
  });

describe("WorkspacePool", () => {
  it.effect(
    "[pool.fork-then-grant] forks to the target, then grants a ready workspace at the mirror's head",
    () =>
      Effect.gen(function* () {
        const base = yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 3 });
        expect(yield* refillPool()).toEqual({ started: 3, ready: 3, failed: 0, abandoned: 0 });
        const grant = yield* grantWorkspace(holder(1));
        expect(grant.baseSha).toBe(base);
        expect(grant.token.length).toBeGreaterThan(0);
        expect(yield* poolStatus()).toMatchObject({ ready: 2, granted: 1, forking: 0 });
        const events = yield* eventsOf(grant.workspaceId);
        expect(events.map((p) => tagOf(p))).toEqual(["WorkspaceForked", "WorkspaceGranted"]);
        expect(events[0]).toMatchObject({ sourceRepo: "mirror" });
        // The remote and the token never travel in an event.
        expect(JSON.stringify(events)).not.toContain(grant.remote);
        expect(JSON.stringify(events)).not.toContain(grant.token);
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.grant-once] ten concurrent grants against five ready workspaces: five distinct grants, five PoolExhausted",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 5 });
        yield* refillPool();
        const outcomes = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, i) => holder(i + 1)),
          (h) => Effect.result(grantWorkspace(h)),
          { concurrency: "unbounded" },
        );
        const granted = outcomes.flatMap((o) =>
          o._tag === "Success" ? [o.success.workspaceId] : [],
        );
        const refused = outcomes.flatMap((o) => (o._tag === "Failure" ? [o.failure._tag] : []));
        expect(new Set(granted).size).toBe(5);
        expect(granted.length).toBe(5);
        expect(refused).toEqual(Array.from({ length: 5 }, () => "PoolExhausted"));
        for (const id of granted)
          expect((yield* eventsOf(id)).filter((p) => tagOf(p) === "WorkspaceGranted").length).toBe(
            1,
          );
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.idempotent] a holder's second grant is the same workspace with a new token, granted once",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        yield* refillPool();
        const first = yield* grantWorkspace(holder(7));
        const again = yield* grantWorkspace(holder(7));
        expect(again.workspaceId).toBe(first.workspaceId);
        expect(again.token).not.toBe(first.token);
        expect(
          (yield* eventsOf(first.workspaceId)).filter((p) => tagOf(p) === "WorkspaceGranted")
            .length,
        ).toBe(1);
        expect(yield* poolStatus()).toMatchObject({ ready: 1, granted: 1 });
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.never-unready] while forks are in flight nothing is granted; once they resolve, one is",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seedMirror;
          yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
          const refill = yield* Effect.forkChild(refillPool());
          // Let the refill commit its slots; its forks then wait on the gate.
          for (let i = 0; i < 100 && (yield* poolStatus()).forking < 2; i++) yield* Effect.yieldNow;
          expect(yield* poolStatus()).toMatchObject({ forking: 2, ready: 0 });
          const early = yield* Effect.flip(grantWorkspace(holder(1)));
          expect(early).toMatchObject({ _tag: "PoolExhausted", retryAfterMs: 5_000 });
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(refill);
          expect((yield* grantWorkspace(holder(1))).workspaceId).toMatch(/^wsp_/);
        }).pipe(Effect.provide(pool({ forkGate: gate })));
      }),
  );

  it.effect("[pool.exhausted] an empty pool refuses with PoolExhausted and a retry hint", () =>
    Effect.gen(function* () {
      yield* seedMirror;
      const refused = yield* Effect.flip(grantWorkspace(holder(1)));
      expect(refused._tag).toBe("PoolExhausted");
      expect(refused.retryAfterMs).toBeGreaterThan(0);
    }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.collect] a released workspace is collected: its repo is deleted and the event names the reason",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
        yield* refillPool();
        const grant = yield* grantWorkspace(holder(3));
        yield* releaseWorkspace(grant.workspaceId, "landed");
        yield* releaseWorkspace(grant.workspaceId, "landed");
        expect(yield* poolStatus()).toMatchObject({ granted: 0, collecting: 1 });
        expect(yield* collectWorkspaces()).toEqual({ deleted: 1, pending: 0 });
        const host = yield* CodeHost;
        const repo = {
          namespace: MIRROR.namespace,
          name: `ws-${grant.workspaceId.slice(4).toLowerCase()}`,
        };
        expect((yield* Effect.flip(host.info(repo)))._tag).toBe("RepoNotFound");
        const events = yield* eventsOf(grant.workspaceId);
        expect(events.at(-1)).toEqual({
          _tag: "WorkspaceCollected",
          workspaceId: grant.workspaceId,
          reason: "landed",
        });
        expect(events.filter((p) => tagOf(p) === "WorkspaceCollected").length).toBe(1);
        // The holder is free again: a new grant is a new workspace.
        yield* refillPool();
        expect((yield* grantWorkspace(holder(3))).workspaceId).not.toBe(grant.workspaceId);
      }).pipe(Effect.provide(pool())),
  );

  it.effect("[pool.fresh-names] across refills and collections no repo name is used twice", () =>
    Effect.gen(function* () {
      yield* seedMirror;
      yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
      const repos: string[] = [];
      for (let round = 0; round < 3; round++) {
        yield* refillPool();
        for (const n of [1, 2]) {
          const grant = yield* grantWorkspace(holder(round * 10 + n));
          repos.push(grant.repo.name);
          yield* releaseWorkspace(grant.workspaceId, "withdrawn");
        }
        yield* collectWorkspaces();
      }
      const host = yield* CodeHost;
      expect(new Set(repos).size).toBe(6);
      for (const name of repos)
        expect((yield* Effect.flip(host.info({ namespace: MIRROR.namespace, name })))._tag).toBe(
          "RepoNotFound",
        );
    }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.collect-on-event] a delivered ChangeLanded collects the change's workspace, once",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
        yield* refillPool();
        const grant = yield* grantWorkspace(holder(4));
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        const host = yield* CodeHost;
        const landed = {
          type: "ChangeLanded",
          payload: { _tag: "ChangeLanded", changeId: holder(4) },
        };
        const first = store.transaction(() =>
          collectOnChangeEnd({ store, outbox, at: Instant(1) }, landed, 1),
        );
        const again = store.transaction(() =>
          collectOnChangeEnd({ store, outbox, at: Instant(2) }, landed, 2),
        );
        expect(first).toEqual({
          workspaceId: grant.workspaceId,
          drafts: [
            {
              payload: {
                _tag: "WorkspaceCollected",
                workspaceId: grant.workspaceId,
                reason: "landed",
              },
            },
          ],
        });
        expect(again).toBeUndefined();
        expect(yield* collectWorkspaces()).toEqual({ deleted: 1, pending: 0 });
        expect((yield* Effect.flip(host.info(grant.repo)))._tag).toBe("RepoNotFound");
        const queued = {
          type: "ChangeQueued",
          payload: { _tag: "ChangeQueued", changeId: holder(4) },
        };
        expect(
          store.transaction(() => collectOnChangeEnd({ store, outbox, at: Instant(3) }, queued, 3)),
        ).toBeUndefined();
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.token-ttl] a grant's token lives at most two hours, and the grant event carries no token",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
        yield* refillPool();
        const now = yield* EffectClock.currentTimeMillis;
        const grant = yield* grantWorkspace(holder(9));
        expect(GRANT_TTL_SECONDS).toBeLessThanOrEqual(7_200);
        expect(grant.expiresAt - now).toBeLessThanOrEqual(7_200_000);
        expect(grant.expiresAt).toBeGreaterThan(now);
        const granted = (yield* eventsOf(grant.workspaceId)).find(
          (p) => tagOf(p) === "WorkspaceGranted",
        );
        expect(Object.keys(granted ?? {}).toSorted()).toEqual([
          "_tag",
          "baseSha",
          "expiresAt",
          "holder",
          "workspaceId",
        ]);
      }).pipe(Effect.provide(pool())),
  );
});
