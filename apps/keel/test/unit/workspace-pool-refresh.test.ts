// The WorkspacePool's refresh over in-memory ports: real git objects in the
// code host, a trunk the test lands commits on, and a refresher the test can
// hold mid-relay, fail, or have lose its answer after the push landed.
import { describe, expect, it } from "@effect/vitest";
import {
  collectWorkspaces,
  configurePool,
  countBehind,
  destroyPool,
  grantWorkspace,
  poolStatus,
  refillPool,
  refreshSlots,
  Slot,
  STUCK_REFRESH_MS,
} from "@keeltown/core/application/coordination";
import { PushRejected } from "@keeltown/core/domain/integration";
import { ChangeId, type CommitSha, Instant, ProjectId } from "@keeltown/core/kernel";
import {
  Clock,
  CodeHost,
  EntityStore,
  EventOutbox,
  PackTooLarge,
  type RepoRef,
  WorkspaceRefresher,
} from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeTrunksMemory,
  makeWorkspaceRefresherMemory,
} from "@keeltown/testing";
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 60, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const MAIN = "refs/heads/main";
const TRUNK: RepoRef = { namespace: "keel-core", name: "trunk" };
const MIRROR: RepoRef = { namespace: "keel-ws-00", name: "mirror" };
const PROJECT = Schema.decodeUnknownSync(ProjectId)("prj_00000000000000000000000001");
const holder = (n: number) =>
  Schema.decodeUnknownSync(ChangeId)(`chg_${String(n).padStart(26, "0")}`);

/**
 * What one relay does, in the order the relays are asked for:
 * - `pass`: main moves and the answer arrives;
 * - `hold-before`: it waits, with nothing written yet, until the test lets it go;
 * - `hold-after`: main moves, then it waits before answering;
 * - `lost`: main moves and the answer never arrives;
 * - `die`: it fails before anything is written;
 * - `busy`, `too-large`: the port's own refusals, with nothing written.
 */
type Relay = "pass" | "hold-before" | "hold-after" | "lost" | "die" | "busy" | "too-large";

/** Waits, yielding to the other fibers, until `done`. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 10_000 && !done(); i++) yield* Effect.yieldNow;
    yield* done() ? Effect.void : Effect.die(new Error("the awaited state never came"));
  });

/** The pool's ports, a trunk, and a refresher that follows `script`, then passes. */
function world(script: Relay[] = []) {
  const code = makeCodeHostMemory();
  const outbox = makeEventOutboxMemory();
  const trunks = makeTrunksMemory();
  const memory = makeWorkspaceRefresherMemory(code, () => TRUNK);
  let now = 1_700_000_000_000;
  /** Each relay asked for, in order. */
  const relays: { workspace: string; from: CommitSha; to: CommitSha }[] = [];
  /** The workspaces a relay is writing right now, and the most there ever were at once. */
  const inFlight = new Set<string>();
  const seen = { peak: 0 };
  /** The relays waiting to be let go. */
  const holds: Deferred.Deferred<void>[] = [];
  /** Repos whose main cannot be read. */
  const unreadable = new Set<string>();

  const host = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (inner) =>
      CodeHost.of({
        ...inner,
        head: (repo, ref) =>
          unreadable.has(repo.name)
            ? Effect.die(new Error("the code host did not answer"))
            : inner.head(repo, ref),
      }),
    ),
  ).pipe(Layer.provideMerge(code.layer));

  const refresher = Layer.effect(
    WorkspaceRefresher,
    Effect.map(WorkspaceRefresher, (inner) =>
      WorkspaceRefresher.of({
        advance: (projectId, workspace, from, to) => {
          const step = script.shift() ?? "pass";
          const write = inner.advance(projectId, workspace, from, to);
          const hold = Effect.gen(function* () {
            const gate = yield* Deferred.make<void>();
            holds.push(gate);
            yield* Deferred.await(gate);
          });
          const relay = {
            pass: write,
            "hold-before": Effect.andThen(hold, write),
            "hold-after": Effect.tap(write, () => hold),
            lost: Effect.andThen(
              write,
              Effect.die(new Error("the connection dropped after the push")),
            ),
            die: Effect.die(new Error("the connection dropped before the push")),
            busy: Effect.fail(new PushRejected({ reason: "busy" })),
            "too-large": Effect.fail(
              new PackTooLarge({ repo: workspace, bytes: 70_000_000, limit: 62_914_560 }),
            ),
          };
          return Effect.suspend(() => {
            relays.push({ workspace: workspace.name, from, to });
            inFlight.add(workspace.name);
            seen.peak = Math.max(seen.peak, inFlight.size);
            return relay[step];
          }).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(workspace.name))));
        },
      }),
    ),
  ).pipe(Layer.provide(memory.layer));

  const clock = Layer.succeed(Clock, Clock.of({ now: Effect.sync(() => Instant(now)) }));

  /** Trunk moves on by one commit, and its Trunk DO says so. The mirror is not told: it lags. */
  const land = (n: number) =>
    Effect.gen(function* () {
      const sha = yield* code.fixture.commit(TRUNK, MAIN, { "README.md": `landing ${n}\n` });
      trunks.heads.set(PROJECT, sha);
      return sha;
    });

  /** A trunk with one commit, a mirror forked from it, and a pool of `target` ready workspaces on that commit. */
  const stock = (target: number) =>
    Effect.gen(function* () {
      const inner = yield* CodeHost;
      yield* inner.create(TRUNK);
      const base = yield* code.fixture.commit(TRUNK, MAIN, { "README.md": "forge-lite\n" });
      yield* inner.fork(TRUNK, MIRROR);
      trunks.heads.set(PROJECT, base);
      yield* configurePool(PROJECT, { source: MIRROR, target });
      yield* refillPool(PROJECT);
      return base;
    });

  return {
    layer: Layer.mergeAll(
      host,
      outbox.layer,
      makeIdsMemory().layer,
      clock,
      trunks.layer,
      refresher,
    ),
    fixture: code.fixture,
    relays,
    inFlight,
    seen,
    holds,
    unreadable,
    until,
    land,
    stock,
    /** Waits until a relay is held. */
    held: until(() => holds.length > 0),
    /** Lets the relay held longest go. */
    release: Effect.suspend(() => {
      const gate = holds.shift();
      return gate === undefined ? Effect.void : Deferred.succeed(gate, undefined);
    }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Every slot the pool holds, as stored, in fork order. */
const slotsHeld = Effect.map(EntityStore, (store) =>
  store
    .list("workspace")
    .map((row) => Schema.decodeUnknownSync(Slot)(row.value))
    .toSorted((a, b) => (a.id < b.id ? -1 : 1)),
);

const mainOf = (repo: RepoRef) => Effect.flatMap(CodeHost, (host) => host.head(repo, MAIN));

const tagOf = (payload: unknown): string =>
  typeof payload === "object" && payload !== null && "_tag" in payload ? String(payload._tag) : "";

/** The events the pool committed for a workspace. */
const eventsOf = (id: Slot["id"]) =>
  Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "workspace", id }).map((e) => e.payload));

/** Why a workspace was collected, once per WorkspaceCollected. */
const collectedAs = (id: Slot["id"]) =>
  Effect.map(eventsOf(id), (events) =>
    events
      .filter((p) => tagOf(p) === "WorkspaceCollected")
      .map((p) => (typeof p === "object" && p !== null ? Reflect.get(p, "reason") : undefined)),
  );

/** The one slot of a pool of one. */
const onlySlot = Effect.flatMap(slotsHeld, (held) => {
  const [slot] = held;
  return slot === undefined || held.length !== 1
    ? Effect.die(new Error(`expected one slot, found ${held.length}`))
    : Effect.succeed(slot);
});

/** The three slots of a pool of three, in fork order. */
const threeSlots = Effect.flatMap(slotsHeld, (held) => {
  const [first, second, third] = held;
  return first === undefined || second === undefined || third === undefined || held.length !== 3
    ? Effect.die(new Error(`expected three slots, found ${held.length}`))
    : Effect.succeed([first, second, third] as const);
});

describe("WorkspacePool refresh", () => {
  it.effect(
    "[pool.refresh] after trunk moves, a pass brings every ready workspace's main and base to trunk's head, with no event, and the next grant says so",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.stock(2);
        expect(yield* countBehind(PROJECT)).toBe(0);
        const head = yield* w.land(1);
        expect(yield* countBehind(PROJECT)).toBe(2);

        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 2, failed: 0, pending: 0 });
        for (const slot of yield* slotsHeld) {
          expect(slot).toMatchObject({ state: "ready", baseSha: head });
          expect("advancingTo" in slot).toBe(false);
          expect(yield* mainOf(slot.repo)).toBe(head);
          expect((yield* eventsOf(slot.id)).map(tagOf)).toEqual(["WorkspaceForked"]);
        }
        expect(w.relays.map((r) => [r.from, r.to])).toEqual([
          [base, head],
          [base, head],
        ]);

        const grant = yield* grantWorkspace(PROJECT, holder(1));
        expect(grant.baseSha).toBe(head);
        expect((yield* eventsOf(grant.workspaceId)).at(-1)).toMatchObject({
          _tag: "WorkspaceGranted",
          baseSha: head,
        });

        // Nothing is behind now: a pass relays nothing and leaves nothing pending.
        expect(yield* countBehind(PROJECT)).toBe(0);
        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 0 });
        expect(w.relays).toHaveLength(2);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-base-after-relay] a workspace's base moves only once its relay has answered: mid-relay it still names the commit main was seen at, and a relay that fails leaves it there",
    () => {
      const w = world(["hold-after", "die"]);
      return Effect.gen(function* () {
        const base = yield* w.stock(1);
        const head = yield* w.land(1);
        const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
        yield* w.held;
        const mid = yield* onlySlot;
        // Main has moved and the answer has not arrived.
        expect(yield* mainOf(mid.repo)).toBe(head);
        expect(mid).toMatchObject({ state: "refreshing", baseSha: base, advancingTo: head });
        yield* w.release;
        expect(yield* Fiber.join(pass)).toEqual({ refreshed: 1, failed: 0, pending: 0 });
        expect(yield* onlySlot).toMatchObject({ state: "ready", baseSha: head });

        // The next relay fails before it writes: the workspace stays ready on the base it has.
        const next = yield* w.land(2);
        expect(next).not.toBe(head);
        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 1 });
        const kept = yield* onlySlot;
        expect(kept).toMatchObject({ state: "ready", baseSha: head });
        expect("advancingTo" in kept).toBe(false);
        expect(yield* mainOf(kept.repo)).toBe(head);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-readback] a relay with no answer to trust is settled by reading main back: landed is ready on trunk's head, unmoved is retried, and a main anywhere else, or gone, is collected",
    () =>
      Effect.gen(function* () {
        // The push landed and its answer was lost.
        const lost = world(["lost"]);
        yield* Effect.gen(function* () {
          yield* lost.stock(1);
          const head = yield* lost.land(1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 1, failed: 0, pending: 0 });
          expect(yield* onlySlot).toMatchObject({ state: "ready", baseSha: head });
        }).pipe(Effect.provide(lost.layer));

        // The workspace stayed busy: nothing moved, and the next pass relays it.
        const busy = world(["busy"]);
        yield* Effect.gen(function* () {
          const base = yield* busy.stock(1);
          const head = yield* busy.land(1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 1 });
          expect(yield* onlySlot).toMatchObject({ state: "ready", baseSha: base });
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 1, failed: 0, pending: 0 });
          expect(yield* onlySlot).toMatchObject({ state: "ready", baseSha: head });
        }).pipe(Effect.provide(busy.layer));

        // Something else wrote main: the push is refused, and the pool cannot vouch for what is there.
        const moved = world();
        yield* Effect.gen(function* () {
          yield* moved.stock(1);
          const slot = yield* onlySlot;
          yield* moved.fixture.commit(slot.repo, MAIN, { "README.md": "not trunk's\n" });
          yield* moved.land(1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 1, pending: 0 });
          expect(yield* onlySlot).toMatchObject({ state: "collecting" });
          expect(yield* collectedAs(slot.id)).toEqual(["expired"]);
          // Its repo is deleted, and the refill forks its replacement.
          expect(yield* collectWorkspaces(PROJECT)).toEqual({ deleted: 1, pending: 0 });
          expect(yield* refillPool(PROJECT)).toMatchObject({ started: 1, ready: 1 });
        }).pipe(Effect.provide(moved.layer));

        // The repo is gone.
        const gone = world();
        yield* Effect.gen(function* () {
          yield* gone.stock(1);
          const slot = yield* onlySlot;
          yield* (yield* CodeHost).delete(slot.repo);
          yield* gone.land(1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 1, pending: 0 });
          expect(yield* onlySlot).toMatchObject({ state: "collecting" });
        }).pipe(Effect.provide(gone.layer));

        // The relay failed and main cannot be read either: nothing is assumed.
        const blind = world(["die"]);
        yield* Effect.gen(function* () {
          const base = yield* blind.stock(1);
          const slot = yield* onlySlot;
          yield* blind.land(1);
          blind.unreadable.add(slot.repo.name);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 1 });
          expect(yield* onlySlot).toMatchObject({ state: "refreshing", baseSha: base });
        }).pipe(Effect.provide(blind.layer));
      }),
  );

  it.effect(
    "[pool.refresh-too-large] a workspace too far behind to relay is collected, not retried",
    () => {
      const w = world(["too-large"]);
      return Effect.gen(function* () {
        yield* w.stock(1);
        const slot = yield* onlySlot;
        yield* w.land(1);
        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 1, pending: 0 });
        expect(yield* onlySlot).toMatchObject({ state: "collecting" });
        expect(yield* collectedAs(slot.id)).toEqual(["expired"]);
        expect(w.relays).toHaveLength(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-one-at-a-time] workspaces are refreshed one at a time, the one that has waited longest first, and the others stay grantable meanwhile",
    () => {
      const w = world(["hold-before", "hold-before", "hold-before"]);
      return Effect.gen(function* () {
        const base = yield* w.stock(3);
        const head = yield* w.land(1);
        const [first, second, third] = yield* threeSlots;

        const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
        yield* w.held;
        expect((yield* slotsHeld).map((s) => s.state)).toEqual(["refreshing", "ready", "ready"]);
        expect(w.holds).toHaveLength(1);
        // A workspace behind trunk beats none: the next in line is granted as it stands.
        const grant = yield* grantWorkspace(PROJECT, holder(1));
        expect(grant).toMatchObject({ workspaceId: second.id, baseSha: base });

        yield* w.release;
        yield* w.held;
        expect((yield* slotsHeld).map((s) => s.state)).toEqual(["ready", "granted", "refreshing"]);
        yield* w.release;
        expect(yield* Fiber.join(pass)).toEqual({ refreshed: 2, failed: 0, pending: 0 });

        expect(w.relays.map((r) => r.workspace)).toEqual([first.repo.name, third.repo.name]);
        expect(w.seen.peak).toBe(1);
        expect((yield* slotsHeld).map((s) => s.baseSha)).toEqual([head, base, head]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-granted-untouched] a granted workspace is never written: its main and its base stay its holder's",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.stock(2);
        const grant = yield* grantWorkspace(PROJECT, holder(1));
        const head = yield* w.land(1);

        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 1, failed: 0, pending: 0 });
        expect(w.relays.map((r) => r.workspace)).not.toContain(grant.repo.name);
        expect(w.relays).toHaveLength(1);
        const held = (yield* slotsHeld).find((s) => s.id === grant.workspaceId);
        expect(held).toMatchObject({ state: "granted", baseSha: base, holder: holder(1) });
        expect(yield* mainOf(grant.repo)).toBe(base);
        expect(head).not.toBe(base);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it("[pool.refresh-never-granted-mid-relay] however grants, landings and refresh passes interleave, no grant hands out a workspace a relay is writing, and every granted base is that workspace's main", async () => {
    const op = fc.constantFrom("land", "refresh", "step", "grant");
    const holding = fc.constantFrom<Relay>("hold-before", "hold-after");
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { minLength: 1, maxLength: 14 }),
        fc.array(holding, { minLength: 1, maxLength: 4 }),
        (ops, kinds) => {
          const w = world(Array.from({ length: 64 }, (_, i) => kinds[i % kinds.length] ?? "pass"));
          return Effect.runPromise(
            Effect.gen(function* () {
              yield* w.stock(3);
              let pass: Fiber.Fiber<unknown> | undefined;
              let running = false;
              let landings = 0;
              let holders = 0;
              const paused = w.until(() => w.holds.length > 0 || !running);
              for (const step of ops) {
                if (step === "land") yield* w.land((landings += 1));
                if (step === "refresh" && !running) {
                  running = true;
                  pass = yield* Effect.forkChild(
                    refreshSlots(PROJECT).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          running = false;
                        }),
                      ),
                    ),
                  );
                  yield* paused;
                }
                if (step === "step" && w.holds.length > 0) {
                  yield* w.release;
                  yield* paused;
                }
                if (step === "grant") {
                  const grant = yield* Effect.exit(grantWorkspace(PROJECT, holder((holders += 1))));
                  if (Exit.isSuccess(grant)) {
                    expect(w.inFlight.has(grant.value.repo.name)).toBe(false);
                    expect(yield* mainOf(grant.value.repo)).toBe(grant.value.baseSha);
                    // Keep the pool stocked: the mirror lags, so the new workspace starts behind.
                    yield* refillPool(PROJECT);
                  }
                }
              }
              while (w.holds.length > 0) {
                yield* w.release;
                yield* paused;
              }
              if (pass !== undefined) yield* Fiber.join(pass);
              for (const slot of yield* slotsHeld) {
                if (slot.state === "ready") expect(yield* mainOf(slot.repo)).toBe(slot.baseSha);
                expect(slot.state).not.toBe("refreshing");
              }
              expect(w.seen.peak).toBeLessThanOrEqual(1);
            }).pipe(Effect.provide(w.layer)),
          );
        },
      ),
      // A grant asked for while the first relay has written main and not yet answered.
      { examples: [[["land", "refresh", "grant", "step"], ["hold-after"]]] },
    );
  });

  it.effect(
    "[pool.refresh-stuck] a workspace a dead pass left mid-relay is left alone for two minutes, then settled by reading its main: where the relay was taking it, where it was, or collected",
    () =>
      Effect.gen(function* () {
        // The pass died after the push landed; trunk has moved again since.
        const landed = world(["hold-after"]);
        yield* Effect.gen(function* () {
          const base = yield* landed.stock(1);
          const first = yield* landed.land(1);
          const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
          yield* landed.held;
          yield* Fiber.interrupt(pass);
          expect(yield* onlySlot).toMatchObject({
            state: "refreshing",
            baseSha: base,
            advancingTo: first,
          });
          const second = yield* landed.land(2);

          // At two minutes its pass may still be running.
          landed.advance(STUCK_REFRESH_MS);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 1 });
          expect(yield* onlySlot).toMatchObject({ state: "refreshing", baseSha: base });
          expect(landed.relays).toHaveLength(1);

          // Past it, main is read: it stands where the relay was taking it, and from there it follows trunk.
          landed.advance(1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 1, failed: 0, pending: 0 });
          expect(landed.relays.map((r) => [r.from, r.to])).toEqual([
            [base, first],
            [first, second],
          ]);
          const slot = yield* onlySlot;
          expect(slot).toMatchObject({ state: "ready", baseSha: second });
          expect(yield* mainOf(slot.repo)).toBe(second);
        }).pipe(Effect.provide(landed.layer));

        // The pass died before the push: main is where it was, and the same pass relays it.
        const unmoved = world(["hold-before"]);
        yield* Effect.gen(function* () {
          const base = yield* unmoved.stock(1);
          const head = yield* unmoved.land(1);
          const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
          yield* unmoved.held;
          yield* Fiber.interrupt(pass);
          unmoved.advance(STUCK_REFRESH_MS + 1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 1, failed: 0, pending: 0 });
          expect(unmoved.relays.map((r) => [r.from, r.to])).toEqual([
            [base, head],
            [base, head],
          ]);
          expect(yield* onlySlot).toMatchObject({ state: "ready", baseSha: head });
        }).pipe(Effect.provide(unmoved.layer));

        // Its main is somewhere the pool never put it.
        const strayed = world(["hold-before"]);
        yield* Effect.gen(function* () {
          yield* strayed.stock(1);
          yield* strayed.land(1);
          const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
          yield* strayed.held;
          yield* Fiber.interrupt(pass);
          const slot = yield* onlySlot;
          yield* strayed.fixture.commit(slot.repo, MAIN, { "README.md": "not trunk's\n" });
          strayed.advance(STUCK_REFRESH_MS + 1);
          expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 1, pending: 0 });
          expect(yield* onlySlot).toMatchObject({ state: "collecting" });
          expect(yield* collectedAs(slot.id)).toEqual(["expired"]);
        }).pipe(Effect.provide(strayed.layer));
      }),
  );

  it.effect(
    "[pool.refresh-exhausted-soon] a pool whose only workspace is mid-relay refuses a grant with a five-second retry, and says how many are refreshing",
    () => {
      const w = world(["hold-before"]);
      return Effect.gen(function* () {
        yield* w.stock(1);
        yield* w.land(1);
        const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
        yield* w.held;
        expect(yield* poolStatus()).toMatchObject({ ready: 0, refreshing: 1, forking: 0 });
        expect(yield* Effect.flip(grantWorkspace(PROJECT, holder(1)))).toMatchObject({
          _tag: "PoolExhausted",
          retryAfterMs: 5_000,
        });
        yield* w.release;
        yield* Fiber.join(pass);
        expect(yield* poolStatus()).toMatchObject({ ready: 1, refreshing: 0 });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-no-overfork] a workspace mid-relay counts towards the target: a refill meanwhile forks nothing",
    () => {
      const w = world(["hold-before"]);
      return Effect.gen(function* () {
        yield* w.stock(2);
        yield* w.land(1);
        const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
        yield* w.held;
        expect(yield* poolStatus()).toMatchObject({ ready: 1, refreshing: 1 });
        expect(yield* refillPool(PROJECT)).toEqual({
          started: 0,
          ready: 0,
          failed: 0,
          abandoned: 0,
        });
        yield* w.release;
        yield* Fiber.join(pass);
        expect(yield* slotsHeld).toHaveLength(2);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-destroy-mid-relay] a workspace given up while its relay ran stays given up, and a destroyed pool refreshes nothing",
    () => {
      const w = world(["hold-after"]);
      return Effect.gen(function* () {
        yield* w.stock(1);
        yield* w.land(1);
        const slot = yield* onlySlot;
        const pass = yield* Effect.forkChild(refreshSlots(PROJECT));
        yield* w.held;
        yield* destroyPool(PROJECT);
        expect(yield* onlySlot).toMatchObject({ state: "collecting" });
        yield* w.release;
        expect(yield* Fiber.join(pass)).toEqual({ refreshed: 0, failed: 0, pending: 0 });
        expect(yield* onlySlot).toMatchObject({ state: "collecting" });
        expect(yield* collectedAs(slot.id)).toEqual(["withdrawn"]);

        yield* w.land(2);
        expect(yield* countBehind(PROJECT)).toBe(0);
        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 0 });
        expect(w.relays).toHaveLength(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[pool.refresh-idle] a pool with no ready workspace asks trunk nothing: an empty pool of a project with no trunk yet counts and refreshes nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        // No trunk was initialized: asking for its head would die.
        expect(yield* countBehind(PROJECT)).toBe(0);
        expect(yield* refreshSlots(PROJECT)).toEqual({ refreshed: 0, failed: 0, pending: 0 });
        expect(w.relays).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );
});
