// The WorkspacePool's use-cases over in-memory ports: real git objects in the
// code host, one transaction covering state and outbox, sequential ids.
import { describe, expect, it } from "@effect/vitest";
import {
  collectOnChangeEnd,
  collectWorkspaces,
  configurePool,
  destroyPool,
  FILL_MS,
  grantWorkspace,
  RECLAIM_FORKING_MS,
  GRANT_TTL_SECONDS,
  holderOf,
  observePush,
  ownerOfRepo,
  poolStatus,
  raisePoolTarget,
  refillPool,
  releaseWorkspace,
  Slot,
  workspaceRepoName,
} from "@keeltown/core/application/coordination";
import {
  ChangeId,
  type CommitSha,
  Instant,
  makeId,
  ProjectId,
  type WorkspaceId,
} from "@keeltown/core/kernel";
import {
  Clock,
  CodeHost,
  EntityStore,
  EventOutbox,
  Trunks,
  WorkspaceRefresher,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeTrunksMemory,
  makeWorkspaceRefresherMemory,
} from "@keeltown/testing";
import { Clock as EffectClock, Deferred, Effect, Fiber, Layer, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";

const MIRROR = { namespace: "keel-ws-00", name: "mirror" };
const PROJECT = Schema.decodeUnknownSync(ProjectId)("prj_00000000000000000000000001");
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

/**
 * The pool's ports, with an optional gate every fork waits on. Trunk here is
 * the mirror itself: its head is the mirror's main, so no workspace is ever
 * behind it and a grant relays nothing (`workspace-pool-refresh.test.ts`
 * holds what a grant does when one is).
 */
function pool(
  options: {
    readonly forkGate?: Deferred.Deferred<void>;
    /** A repo whose main every read of fails as Artifacts' internal error, as keel/keel's mirror's did on 15 Oct. */
    readonly unreadable?: string;
    /** How many reads of `unreadable`'s main fail before they read: every one when not given. */
    readonly unreadableReads?: number;
    /** Every relay into a workspace never answers. */
    readonly relaysHang?: boolean;
    /** Every fork fails. */
    readonly forksFail?: boolean;
  } = {},
) {
  const host = makeCodeHostMemory();
  const outbox = makeEventOutboxMemory();
  const gate = options.forkGate;
  let failing = options.unreadableReads ?? Number.POSITIVE_INFINITY;
  const gated =
    gate === undefined && options.unreadable === undefined && options.forksFail !== true
      ? host.layer
      : Layer.effect(
          CodeHost,
          Effect.gen(function* () {
            const inner = yield* CodeHost;
            return CodeHost.of({
              ...inner,
              head: (repo, ref) =>
                Effect.suspend(() => {
                  if (repo.name !== options.unreadable || failing <= 0)
                    return inner.head(repo, ref);
                  failing -= 1;
                  return Effect.die(new Error(INTERNAL_ERROR));
                }),
              fork: (source, target) =>
                options.forksFail === true
                  ? Effect.die(new Error(INTERNAL_ERROR))
                  : gate === undefined
                    ? inner.fork(source, target)
                    : Deferred.await(gate).pipe(Effect.andThen(inner.fork(source, target))),
            });
          }),
        ).pipe(Layer.provideMerge(host.layer));
  const trunks = Layer.effect(
    Trunks,
    Effect.gen(function* () {
      const inner = yield* Trunks;
      const code = yield* CodeHost;
      return Trunks.of({
        ...inner,
        head: () => code.head(MIRROR, "refs/heads/main").pipe(Effect.orDie),
      });
    }),
  ).pipe(Layer.provide(makeTrunksMemory().layer), Layer.provide(gated));
  return Layer.mergeAll(
    gated,
    outbox.layer,
    makeIdsMemory().layer,
    yieldingClock,
    trunks,
    options.relaysHang === true
      ? Layer.succeed(WorkspaceRefresher, WorkspaceRefresher.of({ advance: () => Effect.never }))
      : makeWorkspaceRefresherMemory(host, () => MIRROR).layer,
  );
}

/** Artifacts' answer to every read of keel/keel's mirror on 15 Oct. */
const INTERNAL_ERROR = "ArtifactsError: An internal error occurred.";

/** A source that exists, but whose main cannot be read (see `pool({ unreadable })`). */
const BROKEN = { namespace: "keel-ws-00", name: "broken-mirror" };

/** `program` and the warnings it logged. */
const warnings = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const said: string[] = [];
    const value = yield* program.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") said.push(String(message));
          }),
        ]),
      ),
    );
    return { value, said };
  });

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

/** Every slot the pool holds, as stored. */
const slotsHeld = Effect.map(EntityStore, (store) =>
  store.list("workspace").map((row) => Schema.decodeUnknownSync(Slot)(row.value)),
);

/** A push to main of `workspaceId`, at `sha`. */
const push = (workspaceId: WorkspaceId, sha: CommitSha) => ({
  workspaceId,
  ref: "refs/heads/main",
  sha,
});

/** The WorkspacePushed the pool committed for a workspace. */
const pushed = (id: WorkspaceId) =>
  Effect.map(eventsOf(id), (events) => events.filter((p) => tagOf(p) === "WorkspacePushed"));

/** Whether the code host still holds the repo. */
const onHost = (repo: { readonly namespace: string; readonly name: string }) =>
  Effect.flatMap(CodeHost, (host) =>
    host.info(repo).pipe(
      Effect.as(true),
      Effect.catchTag("RepoNotFound", () => Effect.succeed(false)),
    ),
  );
/** How many of the pool's workspace repos the code host still holds. */
const reposLeft = Effect.gen(function* () {
  const there = yield* Effect.forEach(yield* slotsHeld, (slot) => onHost(slot.repo));
  return there.filter(Boolean).length;
});
const collectedAs = (id: WorkspaceId) =>
  Effect.map(eventsOf(id), (events) =>
    events
      .filter((p) => tagOf(p) === "WorkspaceCollected")
      .map((p) => (typeof p === "object" && p !== null ? Reflect.get(p, "reason") : undefined)),
  );

describe("WorkspacePool", () => {
  it.effect(
    "[pool.fork-then-grant] forks to the target, then grants a ready workspace at the mirror's head",
    () =>
      Effect.gen(function* () {
        const base = yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 3 });
        expect(yield* refillPool(PROJECT)).toEqual({
          started: 3,
          ready: 3,
          failed: 0,
          abandoned: 0,
        });
        const grant = yield* grantWorkspace(PROJECT, holder(1));
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
    "[pool.raise] raises a pool's target to the Worker's when it keeps fewer, and leaves one kept at more, or at none, as it is",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        expect(yield* raisePoolTarget(PROJECT, 16)).toBe(true);
        expect(yield* poolStatus()).toMatchObject({ target: 16 });
        expect(yield* raisePoolTarget(PROJECT, 4)).toBe(false);
        expect(yield* poolStatus()).toMatchObject({ target: 16 });
        yield* configurePool(PROJECT, { source: MIRROR, target: 0 });
        expect(yield* raisePoolTarget(PROJECT, 16)).toBe(false);
        expect(yield* poolStatus()).toMatchObject({ target: 0 });
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.grant-once] ten concurrent grants against five ready workspaces: five distinct grants, five PoolExhausted",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 5 });
        yield* refillPool(PROJECT);
        const outcomes = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, i) => holder(i + 1)),
          (h) => Effect.result(grantWorkspace(PROJECT, h)),
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
        yield* refillPool(PROJECT);
        const first = yield* grantWorkspace(PROJECT, holder(7));
        const again = yield* grantWorkspace(PROJECT, holder(7));
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
          const refill = yield* Effect.forkChild(refillPool(PROJECT));
          // Let the refill commit its slots; its forks then wait on the gate.
          for (let i = 0; i < 100 && (yield* poolStatus()).forking < 2; i++) yield* Effect.yieldNow;
          expect(yield* poolStatus()).toMatchObject({ forking: 2, ready: 0 });
          const early = yield* Effect.flip(grantWorkspace(PROJECT, holder(1)));
          expect(early).toMatchObject({ _tag: "PoolExhausted", retryAfterMs: 5_000 });
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(refill);
          expect((yield* grantWorkspace(PROJECT, holder(1))).workspaceId).toMatch(/^wsp_/);
        }).pipe(Effect.provide(pool({ forkGate: gate })));
      }),
  );

  it.effect("[pool.exhausted] an empty pool refuses with PoolExhausted and a retry hint", () =>
    Effect.gen(function* () {
      yield* seedMirror;
      const refused = yield* Effect.flip(grantWorkspace(PROJECT, holder(1)));
      expect(refused._tag).toBe("PoolExhausted");
      expect(refused.retryAfterMs).toBeGreaterThan(0);
    }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.ready-at] a pool told when its first workspace can be made sends a grant back no sooner, and one told nothing answers as it always has",
    () =>
      Effect.gen(function* () {
        const refusedAfter = Effect.map(
          Effect.flip(grantWorkspace(PROJECT, holder(1))),
          (refused) => refused.retryAfterMs,
        );
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 0, readyAt: Instant(120_000) });
        expect(yield* refusedAfter).toBe(120_000);
        yield* TestClock.adjust("100 seconds");
        expect(yield* refusedAfter).toBe(20_000);
        // Within the usual wait of it, or past it, the usual wait stands.
        yield* TestClock.adjust("10 seconds");
        expect(yield* refusedAfter).toBe(15_000);
        yield* TestClock.adjust("1 hour");
        expect(yield* refusedAfter).toBe(15_000);

        // Configured again without one, the pool keeps none.
        yield* configurePool(PROJECT, { source: MIRROR, target: 0, readyAt: Instant(7_200_000) });
        yield* configurePool(PROJECT, { source: MIRROR, target: 0 });
        expect(yield* refusedAfter).toBe(15_000);
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.collect] a released workspace is collected: its repo is deleted and the event names the reason",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
        yield* refillPool(PROJECT);
        const grant = yield* grantWorkspace(PROJECT, holder(3));
        yield* releaseWorkspace(PROJECT, grant.workspaceId, "landed");
        yield* releaseWorkspace(PROJECT, grant.workspaceId, "landed");
        expect(yield* poolStatus()).toMatchObject({ granted: 0, collecting: 1 });
        // Released is not yet deleted: the repo is there until the collection pass.
        expect(yield* onHost(grant.repo)).toBe(true);
        expect(yield* collectWorkspaces(PROJECT)).toEqual({ deleted: 1, pending: 0 });
        expect(yield* onHost(grant.repo)).toBe(false);
        const events = yield* eventsOf(grant.workspaceId);
        expect(events.at(-1)).toEqual({
          _tag: "WorkspaceCollected",
          workspaceId: grant.workspaceId,
          reason: "landed",
        });
        expect(events.filter((p) => tagOf(p) === "WorkspaceCollected").length).toBe(1);
        // The holder is free again: a new grant is a new workspace.
        yield* refillPool(PROJECT);
        expect((yield* grantWorkspace(PROJECT, holder(3))).workspaceId).not.toBe(grant.workspaceId);
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.project] WorkspaceForked, WorkspaceGranted and WorkspaceCollected carry the pool's project",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
        yield* refillPool(PROJECT);
        const grant = yield* grantWorkspace(PROJECT, holder(5));
        yield* releaseWorkspace(PROJECT, grant.workspaceId, "withdrawn");
        const log = (yield* EventOutbox).log({ kind: "workspace", id: grant.workspaceId });
        expect(log.map((e) => [e.type, e.project])).toEqual([
          ["WorkspaceForked", PROJECT],
          ["WorkspaceGranted", PROJECT],
          ["WorkspaceCollected", PROJECT],
        ]);
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.names] a workspace's repo is named for its project and its id, so a push to it names its pool",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 3 });
        yield* refillPool(PROJECT);
        const held = yield* slotsHeld;
        expect(held).toHaveLength(3);
        for (const slot of held) {
          expect(slot.repo).toEqual({
            namespace: MIRROR.namespace,
            name: workspaceRepoName(PROJECT, slot.id),
          });
          expect(ownerOfRepo(slot.repo.name)).toEqual({
            kind: "workspace",
            projectId: PROJECT,
            id: slot.id,
          });
        }
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[push.no-self-loop] only a push that moves a granted workspace past its base is an agent's: each is recorded once, and a push to a ready, released or unknown one, or one that leaves main on its base, is ignored",
    () =>
      Effect.gen(function* () {
        const base = yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        yield* refillPool(PROJECT);
        const grant = yield* grantWorkspace(PROJECT, holder(1));
        const ready = (yield* slotsHeld).find((slot) => slot.state === "ready")?.id;
        if (ready === undefined) throw new Error("the pool kept no ready workspace");
        const first = yield* Effect.flatMap(CodeHostFixture, (fixture) =>
          fixture.commit(grant.repo, "refs/heads/main", { "README.md": "the agent's edit\n" }),
        );
        const next = yield* Effect.flatMap(CodeHostFixture, (fixture) =>
          fixture.commit(grant.repo, "refs/heads/main", { "README.md": "its next edit\n" }),
        );
        // Main on the workspace's own base holds nothing of the agent's: Keel put it there.
        expect(yield* observePush(PROJECT, "push-0", push(grant.workspaceId, base))).toBe(
          "ignored",
        );
        expect(yield* observePush(PROJECT, "push-1", push(grant.workspaceId, first))).toBe(
          "recorded",
        );
        // The same Workflow instance, retried, and the agent's next push.
        expect(yield* observePush(PROJECT, "push-1", push(grant.workspaceId, first))).toBe(
          "recorded",
        );
        expect(yield* observePush(PROJECT, "push-2", push(grant.workspaceId, next))).toBe(
          "recorded",
        );
        expect(yield* observePush(PROJECT, "push-3", push(ready, base))).toBe("ignored");
        const unknown = makeId("wsp", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
        expect(yield* observePush(PROJECT, "push-4", push(unknown, base))).toBe("ignored");
        yield* releaseWorkspace(PROJECT, grant.workspaceId, "withdrawn");
        expect(yield* observePush(PROJECT, "push-5", push(grant.workspaceId, next))).toBe(
          "ignored",
        );
        expect(yield* pushed(grant.workspaceId)).toEqual([
          { _tag: "WorkspacePushed", ...push(grant.workspaceId, first) },
          { _tag: "WorkspacePushed", ...push(grant.workspaceId, next) },
        ]);
        expect(yield* pushed(ready)).toEqual([]);
        expect(yield* pushed(unknown)).toEqual([]);
      }).pipe(Effect.provide(pool())),
  );

  it.effect("[pool.fresh-names] across refills and collections no repo name is used twice", () =>
    Effect.gen(function* () {
      yield* seedMirror;
      yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
      const repos: string[] = [];
      for (let round = 0; round < 3; round++) {
        yield* refillPool(PROJECT);
        for (const n of [1, 2]) {
          const grant = yield* grantWorkspace(PROJECT, holder(round * 10 + n));
          repos.push(grant.repo.name);
          yield* releaseWorkspace(PROJECT, grant.workspaceId, "withdrawn");
        }
        yield* collectWorkspaces(PROJECT);
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
    "[pool.holder] a granted workspace's holder is its change; a ready, a collected and an unknown workspace have none",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        yield* refillPool(PROJECT);
        const grant = yield* grantWorkspace(PROJECT, holder(5));
        expect(yield* holderOf(grant.workspaceId)).toBe(holder(5));
        const ready = (yield* slotsHeld).filter((slot) => slot.state === "ready");
        expect(ready).toHaveLength(1);
        for (const slot of ready) expect(yield* holderOf(slot.id)).toBeUndefined();
        const store = yield* EntityStore;
        const outbox = yield* EventOutbox;
        const landed = {
          type: "ChangeLanded",
          payload: { _tag: "ChangeLanded", changeId: holder(5) },
        };
        store.transaction(() => collectOnChangeEnd({ store, outbox, at: Instant(1) }, landed, 1));
        expect(yield* holderOf(grant.workspaceId)).toBeUndefined();
        expect(yield* holderOf(makeId("wsp", "0".repeat(26)))).toBeUndefined();
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.collect-on-event] a delivered ChangeLanded collects the change's workspace, once",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
        yield* refillPool(PROJECT);
        const grant = yield* grantWorkspace(PROJECT, holder(4));
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
        expect(yield* collectWorkspaces(PROJECT)).toEqual({ deleted: 1, pending: 0 });
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
        yield* refillPool(PROJECT);
        const now = yield* EffectClock.currentTimeMillis;
        const grant = yield* grantWorkspace(PROJECT, holder(9));
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
  it.effect(
    "[pool.destroy] destroying the pool gives up every workspace, ready or granted, and collection deletes each repo; the mirror is not the pool's to delete",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 3 });
        yield* refillPool(PROJECT);
        const grant = yield* grantWorkspace(PROJECT, holder(1));
        expect(yield* poolStatus()).toMatchObject({ ready: 2, granted: 1, destroyed: false });

        yield* destroyPool(PROJECT);
        expect(yield* poolStatus()).toMatchObject({
          target: 0,
          ready: 0,
          forking: 0,
          granted: 0,
          collecting: 3,
          destroyed: true,
        });
        expect(yield* reposLeft).toBe(3);
        expect(yield* collectWorkspaces(PROJECT)).toEqual({ deleted: 3, pending: 0 });
        expect(yield* reposLeft).toBe(0);
        expect(yield* onHost(MIRROR)).toBe(true);
        expect(yield* poolStatus()).toMatchObject({ collecting: 0, destroyed: true });

        // Each workspace is collected once, as withdrawn, however often the pool is destroyed.
        yield* destroyPool(PROJECT);
        for (const slot of yield* slotsHeld) {
          expect(slot.state).toBe("collected");
          expect(yield* collectedAs(slot.id)).toEqual(["withdrawn"]);
        }
        expect(yield* collectedAs(grant.workspaceId)).toEqual(["withdrawn"]);
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[destroy.refuses-grants] a destroyed pool grants nothing, not a holder's own workspace again, and forks nothing whatever it is configured to",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        yield* refillPool(PROJECT);
        yield* grantWorkspace(PROJECT, holder(1));
        yield* destroyPool(PROJECT);
        yield* collectWorkspaces(PROJECT);

        for (const who of [holder(1), holder(2)])
          expect(yield* Effect.flip(grantWorkspace(PROJECT, who))).toMatchObject({
            _tag: "PoolExhausted",
            retryAfterMs: 15_000,
          });
        expect(yield* configurePool(PROJECT, { source: MIRROR, target: 2 })).toMatchObject({
          target: 2,
          destroyed: true,
        });
        expect(yield* refillPool(PROJECT)).toEqual({
          started: 0,
          ready: 0,
          failed: 0,
          abandoned: 0,
        });
        expect(yield* slotsHeld).toHaveLength(2);
        expect(yield* reposLeft).toBe(0);
        expect((yield* Effect.flip(grantWorkspace(PROJECT, holder(3))))._tag).toBe("PoolExhausted");
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.fill-from-trunk] a refill whose source cannot be read forks nothing and makes a workspace from trunk, one a pass, and a grant gets it",
    () =>
      Effect.gen(function* () {
        const base = yield* seedMirror;
        yield* (yield* CodeHost).create(BROKEN);
        yield* configurePool(PROJECT, { source: BROKEN, target: 3 });
        const first = yield* warnings(refillPool(PROJECT));
        expect(first.value).toEqual({ started: 1, ready: 1, failed: 0, abandoned: 0 });
        expect(first.said).toHaveLength(1);
        expect(first.said[0]).toContain(`source ${BROKEN.namespace}/${BROKEN.name} cannot be read`);
        expect(first.said[0]).toContain(INTERNAL_ERROR);
        expect(yield* refillPool(PROJECT)).toMatchObject({ started: 1, ready: 1 });
        expect(yield* poolStatus()).toMatchObject({ ready: 2, forking: 0 });

        const grant = yield* grantWorkspace(PROJECT, holder(1));
        expect(grant.baseSha).toBe(base);
        const events = yield* eventsOf(grant.workspaceId);
        expect(events[0]).toMatchObject({ _tag: "WorkspaceForked", sourceRepo: "trunk" });
        const slot = (yield* slotsHeld).find((s) => s.id === grant.workspaceId);
        expect(yield* (yield* CodeHost).head(slot!.repo, "refs/heads/main")).toBe(base);
      }).pipe(Effect.provide(pool({ unreadable: BROKEN.name }))),
  );

  it.effect(
    "[pool.source-blip] a source whose main fails one read and then reads is forked as ever",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        const { value, said } = yield* warnings(refillPool(PROJECT));
        expect(value).toEqual({ started: 2, ready: 2, failed: 0, abandoned: 0 });
        expect(said).toEqual([]);
      }).pipe(Effect.provide(pool({ unreadable: MIRROR.name, unreadableReads: 1 }))),
  );

  it.effect(
    "[pool.fill-bounded] making a workspace from trunk whose relay never answers fails at FILL_MS, and the slot is collected",
    () =>
      Effect.gen(function* () {
        yield* seedMirror;
        yield* (yield* CodeHost).create(BROKEN);
        yield* configurePool(PROJECT, { source: BROKEN, target: 1 });
        const refill = yield* Effect.forkChild(refillPool(PROJECT));
        for (let i = 0; i < 100 && (yield* poolStatus()).forking < 1; i++) yield* Effect.yieldNow;
        expect(yield* poolStatus()).toMatchObject({ forking: 1 });
        yield* TestClock.adjust(FILL_MS);
        expect(yield* Fiber.join(refill)).toEqual({
          started: 1,
          ready: 0,
          failed: 1,
          abandoned: 0,
        });
        expect(yield* poolStatus()).toMatchObject({ forking: 0, collecting: 1 });
      }).pipe(Effect.provide(pool({ unreadable: BROKEN.name, relaysHang: true }))),
  );

  it.effect(
    "[pool.fork-failed-said] a refill whose forks fail says so for each, naming the source and why, and makes one workspace from trunk",
    () =>
      Effect.gen(function* () {
        const base = yield* seedMirror;
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        const { value, said } = yield* warnings(refillPool(PROJECT));
        expect(value).toEqual({ started: 3, ready: 1, failed: 2, abandoned: 0 });
        expect(said).toHaveLength(2);
        for (const line of said) {
          expect(line).toContain(`fork of ${MIRROR.namespace}/${MIRROR.name}`);
          expect(line).toContain(INTERNAL_ERROR);
        }
        expect((yield* grantWorkspace(PROJECT, holder(1))).baseSha).toBe(base);
      }).pipe(Effect.provide(pool({ forksFail: true }))),
  );

  it.effect(
    "[pool.fill-failed-said] a workspace that cannot be made from trunk either is said and collected, and the pass counts it failed",
    () =>
      Effect.gen(function* () {
        yield* (yield* CodeHost).create(MIRROR);
        yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
        // A mirror with no main cannot be forked, and trunk (the mirror here) has no head to relay.
        const { value, said } = yield* warnings(refillPool(PROJECT));
        expect(value).toEqual({ started: 1, ready: 0, failed: 1, abandoned: 0 });
        expect(said.join("\n")).toContain("from trunk failed");
        expect(yield* poolStatus()).toMatchObject({ ready: 0, forking: 0, collecting: 1 });
      }).pipe(Effect.provide(pool())),
  );

  it.effect(
    "[pool.reclaim-forking] a slot a reset left forking past RECLAIM_FORKING_MS is collected by the next grant, by its state alone, and once the pool refills a grant is granted",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seedMirror;
          yield* configurePool(PROJECT, { source: MIRROR, target: 1 });
          const refill = yield* Effect.forkChild(refillPool(PROJECT));
          for (let i = 0; i < 100 && (yield* poolStatus()).forking < 1; i++) yield* Effect.yieldNow;
          // The object is reset under its fork: the slot stays forking, and nothing will finish it.
          yield* Fiber.interrupt(refill);
          expect(yield* poolStatus()).toMatchObject({ forking: 1 });
          yield* TestClock.adjust(RECLAIM_FORKING_MS + 1_000);
          const refused = yield* warnings(Effect.flip(grantWorkspace(PROJECT, holder(1))));
          expect(refused.value._tag).toBe("PoolExhausted");
          // Said with what the pool holds, so a pool that stays exhausted shows why.
          expect(refused.said.map((line) => JSON.parse(line))).toEqual([
            expect.objectContaining({
              event: "pool-exhausted",
              target: 1,
              forking: 0,
              collecting: 1,
            }),
          ]);
          expect(yield* poolStatus()).toMatchObject({ forking: 0, collecting: 1 });
          yield* Deferred.succeed(gate, undefined);
          expect(yield* refillPool(PROJECT)).toMatchObject({ ready: 1 });
          expect((yield* grantWorkspace(PROJECT, holder(1))).workspaceId).toBeDefined();
        }).pipe(Effect.provide(pool({ forkGate: gate })));
      }),
  );

  it.effect(
    "[pool.destroy-mid-fork] a fork in flight when the pool is destroyed is deleted once it resolves, and never becomes a workspace",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seedMirror;
          yield* configurePool(PROJECT, { source: MIRROR, target: 2 });
          const refill = yield* Effect.forkChild(refillPool(PROJECT));
          for (let i = 0; i < 100 && (yield* poolStatus()).forking < 2; i++) yield* Effect.yieldNow;
          expect(yield* poolStatus()).toMatchObject({ forking: 2 });

          yield* destroyPool(PROJECT);
          expect(yield* poolStatus()).toMatchObject({ forking: 0, collecting: 2 });
          // Collection runs before the forks resolve: there is no repo to delete yet.
          expect(yield* collectWorkspaces(PROJECT)).toEqual({ deleted: 2, pending: 0 });

          yield* Deferred.succeed(gate, undefined);
          expect(yield* Fiber.join(refill)).toEqual({
            started: 2,
            ready: 0,
            failed: 2,
            abandoned: 0,
          });
          expect(yield* reposLeft).toBe(2);
          expect(yield* poolStatus()).toMatchObject({ ready: 0, collecting: 2 });
          expect(yield* collectWorkspaces(PROJECT)).toEqual({ deleted: 2, pending: 0 });
          expect(yield* reposLeft).toBe(0);
          for (const slot of yield* slotsHeld)
            expect((yield* eventsOf(slot.id)).map(tagOf)).toEqual([]);
        }).pipe(Effect.provide(pool({ forkGate: gate })));
      }),
  );
});
