// The WorkspacePool DO in workerd: its RPC through the port adapter, its
// named alarms, concurrent grants and its reaction to a change's end. The
// real CodeHost adapter runs inside the object against the fake Artifacts
// namespace bound as TEST_ARTIFACTS.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  type ChangeId,
  CommitSha,
  EventEnvelope,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { Slot, STUCK_FORK_MS } from "@keeltown/core/application/coordination";
import { EntityStore, EventOutbox, WorkspacePool } from "@keeltown/core/ports";
import { PORTS } from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { WorkspacePoolRpc } from "../../src/adapters/driven/do-rpc/workspace-pool.ts";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import {
  POOL_CLAIM,
  POOL_FORKS,
  POOL_REFILL,
  POOL_REFRESH,
  type WorkspacePoolDO,
} from "../../src/adapters/driving/do/workspace-pool.ts";
import {
  artifactsLocationHint,
  backbone,
  DEFAULT_POOL_TARGET,
  poolTargetOf,
} from "../../src/composition/do.ts";
import { drainAfter } from "./helpers.ts";
import { followTrunk } from "./pool-harness.ts";
import {
  decodeExit,
  EventCodecs,
  type ExitCodec,
  WorkspacePoolCodecs,
} from "../../src/rpc/index.ts";

/** How long a test waits for an alarm the platform may already be running. */
const WAIT = { timeout: 20_000, interval: 25 };

const freshProject = (): ProjectId => makeId("prj", ulid());
const holder = (): ChangeId => makeId("chg", ulid());
// Each pool's events owe the Projector a delivery, drained after every case.
const poolStub = (projectId: string) =>
  drainAfter(env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${projectId}`)));

/** A method's answer, decoded; a failure or defect throws with the answer. */
function valueOf<A, E>(codec: ExitCodec<A, E>, answer: unknown): A {
  const exit = decodeExit(codec, answer);
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`the pool answered a failure: ${JSON.stringify(answer)}`);
}

const statusOf = async (projectId: string) =>
  valueOf(WorkspacePoolCodecs.status, await poolStub(projectId).status());

/** The fake Artifacts namespace composition serves keel-ws-00 from (vitest.config.ts binds it). */
function fakeArtifacts(): Artifacts {
  if (env.TEST_ARTIFACTS === undefined) throw new Error("vitest.config.ts binds TEST_ARTIFACTS");
  return env.TEST_ARTIFACTS;
}

/** A fresh mirror in the fake namespace, with its own head. */
async function mirror() {
  const name = `mirror-${ulid().toLowerCase()}`;
  await fakeArtifacts().create(name);
  return { namespace: "keel-ws-00", name };
}

/** Whether the fake namespace still holds `name`. */
const exists = (name: string) =>
  fakeArtifacts()
    .get(name)
    .then(
      () => true,
      () => false,
    );

/**
 * Configures `projectId`'s pool to fork `target` workspaces from a fresh
 * mirror, runs the refill and waits until they are ready. With `freeze`, the
 * target then drops to 0, so the pool forks no more and exhaustion is exact.
 * Answers what the pool's object follows, for a test to move trunk.
 */
async function stock(projectId: string, target: number, freeze = false) {
  const stub = poolStub(projectId);
  const source = await mirror();
  const followed = await followTrunk(projectId, source);
  await stub.configure({ source, target });
  // The refill is a deadline armed for now; the platform may run it before this line does.
  await runDurableObjectAlarm(stub);
  await vi.waitFor(async () => expect((await statusOf(projectId)).ready).toBe(target), WAIT);
  if (freeze) await stub.configure({ source, target: 0 });
  return followed;
}

/** ChangeLanded for `changeId`, as the Change DO delivers it to its project's pool. */
const landedFor = (projectId: string, changeId: string) =>
  Schema.encodeSync(EventEnvelope)(
    Schema.decodeUnknownSync(EventEnvelope)({
      eventId: makeId("evt", ulid()),
      type: "ChangeLanded",
      entity: { kind: "change", id: changeId },
      seq: 9,
      at: Date.now(),
      dedupeKey: `change:${changeId}/land/ChangeLanded#0`,
      affected: [],
      notified: [`pool:${projectId}`],
      payload: { _tag: "ChangeLanded", changeId },
    }),
  );

const commitSha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const refreshArmed = async (projectId: string) =>
  (await alarmsOf(projectId)).armed.find((a) => a.reason === POOL_REFRESH);

/** The Worker's env with `vars.ARTIFACTS_LOCATION_HINT` set. */
const withHint = (hint: string): Env => Object.assign({}, env, { ARTIFACTS_LOCATION_HINT: hint });

const alarmsOf = (projectId: string) =>
  runInDurableObject(poolStub(projectId), async (_instance: WorkspacePoolDO, state) => ({
    armed: armedAlarms(state.storage),
    alarm: await state.storage.getAlarm(),
  }));

// The real adapter passes the same contract as the in-memory one, through the real object.
PORTS.WorkspacePool.contract("do-rpc", (projectId, capacity) =>
  Layer.unwrap(
    Effect.promise(async () => {
      await stock(projectId, capacity, true);
      return WorkspacePoolRpc(env.WORKSPACE_POOL);
    }),
  ),
);

/** WORKSPACE_POOL, recording each object the adapter addresses and the options it passes. */
function recordingPools() {
  const calls: { name: string | undefined; options: unknown }[] = [];
  const pools = new Proxy(env.WORKSPACE_POOL, {
    get(target, property) {
      if (property === "get")
        return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
          calls.push({ name: id.name, options });
          return target.get(id, options);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { pools, calls };
}

describe("the WorkspacePool RPC adapter", () => {
  it("[pool.rpc.hint] addresses pool:<projectId> with the deployment's location hint, and none when it is unset", async () => {
    const projectId = freshProject();
    await stock(projectId, 1);
    const hinted = recordingPools();
    const grant = await Effect.runPromise(
      WorkspacePool.use((pool) => pool.grant(projectId, holder())).pipe(
        Effect.provide(WorkspacePoolRpc(hinted.pools, "wnam")),
      ),
    );
    expect(hinted.calls).toEqual([
      { name: `pool:${projectId}`, options: { locationHint: "wnam" } },
    ]);
    const plain = recordingPools();
    await Effect.runPromise(
      WorkspacePool.use((pool) => pool.release(projectId, grant.workspaceId)).pipe(
        Effect.provide(WorkspacePoolRpc(plain.pools)),
      ),
    );
    expect(plain.calls).toEqual([{ name: `pool:${projectId}`, options: undefined }]);
  });

  it("[pool.rpc.hint-var] reads the hint from vars.ARTIFACTS_LOCATION_HINT: empty is none, a non-hint fails loudly", () => {
    expect(artifactsLocationHint(env)).toBe("wnam");
    expect(artifactsLocationHint(withHint(""))).toBeUndefined();
    expect(artifactsLocationHint(withHint("wnam"))).toBe("wnam");
    expect(() => artifactsLocationHint(withHint("mars"))).toThrow(/not a location hint/);
  });

  it("[pool.rpc.exhausted] an empty pool answers PoolExhausted through the adapter, never a workspace", async () => {
    const refused = await Effect.runPromise(
      WorkspacePool.use((pool) => Effect.flip(pool.grant(freshProject(), holder()))).pipe(
        Effect.provide(WorkspacePoolRpc(env.WORKSPACE_POOL)),
      ),
    );
    expect(refused).toMatchObject({ _tag: "PoolExhausted", retryAfterMs: 15_000 });
  });

  it("[pool.rpc.holder] a granted workspace's holder is its change; once released, or never forked, it has none", async () => {
    const projectId = freshProject();
    await stock(projectId, 1);
    const changeId = holder();
    const holders = await Effect.runPromise(
      WorkspacePool.use((pool) =>
        Effect.gen(function* () {
          const grant = yield* pool.grant(projectId, changeId);
          const granted = yield* pool.holder(projectId, grant.workspaceId);
          yield* pool.release(projectId, grant.workspaceId);
          const released = yield* pool.holder(projectId, grant.workspaceId);
          const unknown = yield* pool.holder(projectId, makeId("wsp", ulid()));
          return [granted, released, unknown];
        }),
      ).pipe(Effect.provide(WorkspacePoolRpc(env.WORKSPACE_POOL))),
    );
    expect(holders).toEqual([changeId, undefined, undefined]);
  });
});

describe("the WorkspacePool DO", () => {
  it("[pool.do.concurrent] 10 concurrent grant RPCs take 10 different workspaces, each with only its grant's token live", async () => {
    const projectId = freshProject();
    await stock(projectId, 10, true);
    const stub = poolStub(projectId);
    const grants = (await Promise.all(Array.from({ length: 10 }, () => stub.grant(holder())))).map(
      (answer) => valueOf(WorkspacePoolCodecs.grant, answer),
    );
    expect(new Set(grants.map((g) => g.workspaceId)).size).toBe(10);
    expect(new Set(grants.map((g) => g.repo.name)).size).toBe(10);
    expect(await statusOf(projectId)).toMatchObject({ ready: 0, granted: 10 });
    const refused = decodeExit(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(Exit.isFailure(refused)).toBe(true);
    // The fork's day-long token was revoked when the workspace was forked; only the grant's is active.
    const states = await Promise.all(
      grants.map(async (grant) => {
        const { tokens } = await (await fakeArtifacts().get(grant.repo.name)).listTokens();
        return tokens.map((t) => t.state).toSorted();
      }),
    );
    expect(states).toEqual(grants.map(() => ["active", "revoked"]));
  });

  it("[pool.do.raise] a claim on a pool made under a lower target raises it to the Worker's POOL_TARGET, and the refill forks up to it", async () => {
    const projectId = freshProject();
    await stock(projectId, 1);
    const stub = poolStub(projectId);
    valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    await runDurableObjectAlarm(stub);
    await vi.waitFor(
      async () =>
        expect(await statusOf(projectId)).toMatchObject({ target: 2, ready: 2, granted: 1 }),
      WAIT,
    );
  });

  it("[pool.target-of] a pool's target is the Worker's POOL_TARGET, or the default when it is unset or not a positive whole number", () => {
    expect(poolTargetOf(env.POOL_TARGET)).toBe(2);
    expect(poolTargetOf("16")).toBe(16);
    for (const declared of [undefined, "", "0", "-3", "2.5", "many"])
      expect(poolTargetOf(declared)).toBe(DEFAULT_POOL_TARGET);
  });

  it("[pool.do.alarms] refill and collection are named deadlines, armed only while there is work", async () => {
    const projectId = freshProject();
    await stock(projectId, 2);
    // The refill's commits owe the Projector a delivery, so a flush is armed for a moment: wait for it to run.
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );

    const stub = poolStub(projectId);
    const grant = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    // The grant left the pool short, so it armed a refill.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => expect((await statusOf(projectId)).ready).toBe(2), WAIT);

    valueOf(WorkspacePoolCodecs.release, await stub.release(grant.workspaceId, "withdrawn"));
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => expect(await exists(grant.repo.name)).toBe(false), WAIT);
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
    expect(await statusOf(projectId)).toMatchObject({ ready: 2, granted: 0, collecting: 0 });
  });

  it("[pool.do.fork-deadline] a refill arms a deadline STUCK_FORK_MS past its forks' start before any fork starts, so an object that dies under them still refills; a refill that ends withdraws it", async () => {
    const projectId = freshProject();
    const stub = poolStub(projectId);
    const source = await mirror();
    const followed = await followTrunk(projectId, source);
    // Each fork is held, so the refill is caught with its forks under way.
    followed.forksHeld = true;
    const before = Date.now();
    await stub.configure({ source, target: 1 });
    // The platform may run the refill before this line does.
    const ran = runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(followed.forks).toHaveLength(1), WAIT);
    const guard = (await alarmsOf(projectId)).armed.find((a) => a.reason === POOL_FORKS);
    expect(guard?.at).toBeGreaterThan(before + STUCK_FORK_MS);
    expect(guard?.at).toBeLessThanOrEqual((followed.forks[0] ?? 0) + STUCK_FORK_MS + 1_000);
    followed.forksHeld = false;
    await ran;
    await vi.waitFor(async () => expect((await statusOf(projectId)).ready).toBe(1), WAIT);
    expect((await alarmsOf(projectId)).armed.map((a) => a.reason)).not.toContain(POOL_FORKS);
  });

  it("[pool.do.stranded] a pool a dead refill left with a slot forking past STUCK_FORK_MS and no deadline, as deploys before this one did, is refilled on its next wake: the grant answers PoolExhausted and arms the refill, which collects the slot and forks its replacement", async () => {
    const projectId = freshProject();
    await stock(projectId, 1);
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
    const stub = poolStub(projectId);
    // Its one workspace as a refill that died under its fork leaves it: forking since long ago, with no deadline.
    const stranded = await runInDurableObject(stub, (_instance: WorkspacePoolDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.map(EntityStore, (store) => {
          const [row] = store.list("workspace");
          const slot = Schema.decodeUnknownSync(Slot)(row?.value);
          store.transaction(() =>
            store.put(
              "workspace",
              slot.id,
              Schema.encodeSync(Slot)({
                id: slot.id,
                repo: slot.repo,
                state: "forking",
                since: Date.now() - STUCK_FORK_MS - 1_000,
              }),
            ),
          );
          return slot;
        }),
      ),
    );
    expect(await statusOf(projectId)).toMatchObject({ ready: 0, forking: 1 });
    const exhausted = decodeExit(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(Exit.isFailure(exhausted)).toBe(true);
    // The grant armed the refill, and raised the pool to the Worker's POOL_TARGET: the platform may run it before this line does.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(
      async () =>
        expect(await statusOf(projectId)).toMatchObject({ target: 2, ready: 2, forking: 0 }),
      WAIT,
    );
    await vi.waitFor(async () => expect(await exists(stranded.repo.name)).toBe(false), WAIT);
    const granted = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(granted.repo.name).not.toBe(stranded.repo.name);
  });

  it("[pool.do.retry-later] a refill that cannot fork collects what it started and re-arms itself for later, not now", async () => {
    const projectId = freshProject();
    const stub = poolStub(projectId);
    const before = Date.now();
    await stub.configure({
      source: { namespace: "keel-ws-00", name: "no-such-mirror" },
      target: 2,
    });
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => {
      const { armed } = await alarmsOf(projectId);
      expect(armed.map((a) => a.reason)).toEqual([POOL_REFILL]);
      expect(armed[0]?.at).toBeGreaterThanOrEqual(before + 10_000);
      expect(await statusOf(projectId)).toMatchObject({ ready: 0, forking: 0, collecting: 0 });
    }, WAIT);
  });

  it("[pool.do.react] a delivered ChangeLanded collects the change's workspace once; the redelivery is a no-op", async () => {
    const projectId = freshProject();
    await stock(projectId, 1, true);
    const stub = poolStub(projectId);
    const changeId = holder();
    const grant = valueOf(WorkspacePoolCodecs.grant, await stub.grant(changeId));
    const landed = landedFor(projectId, changeId);
    const first = decodeExit(EventCodecs.receive, await stub.receive([landed]));
    const again = decodeExit(EventCodecs.receive, await stub.receive([landed]));
    expect([Exit.isSuccess(first), Exit.isSuccess(again)]).toEqual([true, true]);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => expect(await exists(grant.repo.name)).toBe(false), WAIT);
    const log = await runInDurableObject(stub, (instance: WorkspacePoolDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) =>
          outbox.log({ kind: "workspace", id: grant.workspaceId }),
        ),
      ),
    );
    expect(log.map((e) => e.type)).toEqual([
      "WorkspaceForked",
      "WorkspaceGranted",
      "WorkspaceCollected",
    ]);
    expect(log.at(-1)?.payload).toMatchObject({ reason: "landed" });
    // Every event the pool commits, the reaction's included, carries its project.
    expect(log.map((e) => e.project)).toEqual([projectId, projectId, projectId]);
  });

  it("[pool.do.refresh] a delivered ChangeLanded arms a refresh: the ready workspace is relayed to trunk's head and granted there, a deadline covers the pass while it runs, and nothing stays armed after it", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 2, true);
    const stub = poolStub(projectId);
    const changeId = holder();
    const grant = valueOf(WorkspacePoolCodecs.grant, await stub.grant(changeId));
    // Trunk lands the change: its head moves, and the pool hears of the landing.
    const head = commitSha("c");
    followed.head = head;
    followed.held = true;
    const before = Date.now();
    await stub.receive([landedFor(projectId, changeId)]);
    // Not awaited here: the alarm does not return while its relay is held.
    const alarm = runDurableObjectAlarm(stub);
    try {
      await vi.waitFor(() => expect(followed.relays).toHaveLength(1), WAIT);
      expect(followed.relays[0]).toMatchObject({ from: grant.baseSha, to: head });
      expect(followed.relays[0]?.workspace).not.toBe(grant.repo.name);
      // Mid-relay the workspace is not grantable, and a deadline stands for a pass that dies here.
      expect(await statusOf(projectId)).toMatchObject({ ready: 0, refreshing: 1 });
      expect((await refreshArmed(projectId))?.at).toBeGreaterThanOrEqual(before + 120_000);
    } finally {
      // Whatever was found, the relay is let go, so the alarm returns.
      followed.held = false;
      await alarm;
    }
    await vi.waitFor(
      async () => expect(await statusOf(projectId)).toMatchObject({ ready: 1, refreshing: 0 }),
      WAIT,
    );
    const next = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(next.baseSha).toBe(head);
    expect(next.repo.name).toBe(followed.relays[0]?.workspace);
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
    expect(followed.relays).toHaveLength(1);
  });

  it("[pool.do.refresh-push-ignored] through the real object, a refresh's push reported after its workspace was granted is ignored, and the holder's own push is recorded", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 1, true);
    const stub = poolStub(projectId);
    valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    const head = commitSha("e");
    followed.head = head;
    // The pool is one short. Its refill forks behind trunk, and the refresh relays trunk's head onto the fork.
    await stub.configure({ source: followed.source, target: 1 });
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => {
      expect(followed.relays).toHaveLength(1);
      expect(await statusOf(projectId)).toMatchObject({ ready: 1, refreshing: 0, forking: 0 });
    }, WAIT);
    await stub.configure({ source: { namespace: "keel-ws-00", name: "unused" }, target: 0 });
    const next = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(next.baseSha).toBe(head);
    const observed = async (pushId: string, sha: string) =>
      valueOf(
        WorkspacePoolCodecs.observePush,
        await stub.observePush(pushId, {
          workspaceId: next.workspaceId,
          ref: "refs/heads/main",
          sha,
        }),
      );
    expect(await observed(`relay-${projectId}`, head)).toBe("ignored");
    expect(await observed(`agent-${projectId}`, commitSha("f"))).toBe("recorded");
  });

  it("[pool.do.refresh-after-refill] a refill from a mirror that lags trunk arms a refresh: the workspace it forked is brought to trunk's head before anyone is granted it", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 1, true);
    const stub = poolStub(projectId);
    const first = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    // Trunk moves ahead of the mirror the pool forks from.
    const head = commitSha("d");
    followed.head = head;
    // The grant left the pool short: its refill forks from the mirror, behind trunk.
    await stub.configure({ source: followed.source, target: 1 });
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => {
      expect(followed.relays).toHaveLength(1);
      expect(await statusOf(projectId)).toMatchObject({ ready: 1, refreshing: 0, forking: 0 });
    }, WAIT);
    expect(followed.relays[0]).toMatchObject({ from: first.baseSha, to: head });
    await stub.configure({ source: { namespace: "keel-ws-00", name: "unused" }, target: 0 });
    const next = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(next.baseSha).toBe(head);
    expect(next.repo.name).toBe(followed.relays[0]?.workspace);
  });

  it("[pool.do.refresh-retry] a pass that leaves a workspace behind re-arms itself for later, not now, and is withdrawn once the workspace has followed trunk", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 2, true);
    const stub = poolStub(projectId);
    const changeId = holder();
    const grant = valueOf(WorkspacePoolCodecs.grant, await stub.grant(changeId));
    followed.head = commitSha("e");
    followed.answer = "busy";
    const before = Date.now();
    await stub.receive([landedFor(projectId, changeId)]);
    await runDurableObjectAlarm(stub);
    // The workspace stayed busy and its main is where it was: ready on its old base, with the pass due again.
    await vi.waitFor(async () => {
      expect(followed.relays.length).toBeGreaterThanOrEqual(1);
      expect(await statusOf(projectId)).toMatchObject({ ready: 1, refreshing: 0 });
      const armed = await refreshArmed(projectId);
      expect(armed?.at).toBeGreaterThanOrEqual(before + 1_000);
      expect(armed?.at).toBeLessThan(before + 120_000);
    }, WAIT);
    expect(followed.relays[0]).toMatchObject({ from: grant.baseSha });

    followed.answer = "advanced";
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(stub);
        expect(await refreshArmed(projectId)).toBeUndefined();
      },
      { timeout: 20_000, interval: 250 },
    );
    const next = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(next.baseSha).toBe(followed.head);
  });

  it("[pool.do.destroy] destroy gives up every workspace, its collection deadline deletes their repos, and nothing stays armed", async () => {
    const projectId = freshProject();
    await stock(projectId, 2, true);
    const stub = poolStub(projectId);
    const grant = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(await exists(grant.repo.name)).toBe(true);

    expect(valueOf(WorkspacePoolCodecs.destroy, await stub.destroy())).toMatchObject({
      ready: 0,
      granted: 0,
      forking: 0,
      destroyed: true,
    });
    await runDurableObjectAlarm(stub);
    await vi.waitFor(
      async () =>
        expect(await statusOf(projectId)).toMatchObject({ collecting: 0, destroyed: true }),
      WAIT,
    );
    expect(await exists(grant.repo.name)).toBe(false);
    const slots = await runInDurableObject(stub, (_instance: WorkspacePoolDO, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM entities WHERE kind = 'workspace'")
        .toArray(),
    );
    expect(slots).toHaveLength(2);
    for (const row of slots) {
      const slot: unknown = JSON.parse(row.value);
      expect(slot).toMatchObject({ state: "collected" });
      const name: unknown = Reflect.get(Object(Reflect.get(Object(slot), "repo")), "name");
      expect(await exists(String(name))).toBe(false);
    }
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
    // Destroying again changes nothing and arms nothing that stays.
    expect(valueOf(WorkspacePoolCodecs.destroy, await stub.destroy())).toMatchObject({
      collecting: 0,
      destroyed: true,
    });
    const refused = decodeExit(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(Exit.isFailure(refused) ? JSON.stringify(refused.cause) : "granted").toContain(
      "PoolExhausted",
    );
  });

  it("[pool.do.claim-at-head] through the real object, a claim that arrives before the pool has heard of a landing is granted at trunk's head, and nothing stays armed after it", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 2, true);
    const stub = poolStub(projectId);
    // Trunk has moved and no landing was delivered: both workspaces are behind it.
    const head = commitSha("a");
    followed.head = head;
    const grant = valueOf(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(grant.baseSha).toBe(head);
    expect(followed.relays).toEqual([
      { workspace: grant.repo.name, from: expect.any(String), to: head },
    ]);
    expect(await statusOf(projectId)).toMatchObject({ ready: 1, granted: 1, refreshing: 0 });
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
  });

  it("[pool.do.claim-guarded] while a claim relays trunk into its workspace a deadline of the claim's own stands, for an object that dies there, and it is withdrawn once the claim has its workspace", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 1, true);
    const stub = poolStub(projectId);
    const head = commitSha("b");
    followed.head = head;
    followed.held = true;
    const before = Date.now();
    // Not awaited here: the claim does not return while its relay is held.
    const claim = stub.grant(holder());
    try {
      await vi.waitFor(() => expect(followed.relays).toHaveLength(1), WAIT);
      expect(await statusOf(projectId)).toMatchObject({ ready: 0, refreshing: 1 });
      const armed = (await alarmsOf(projectId)).armed.find((a) => a.reason === POOL_CLAIM);
      expect(armed?.at).toBeGreaterThanOrEqual(before + 120_000);
    } finally {
      // Whatever was found, the relay is let go, so the claim returns.
      followed.held = false;
    }
    expect(valueOf(WorkspacePoolCodecs.grant, await claim).baseSha).toBe(head);
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
  });

  it("[pool.do.claim-overlap] a claim that ends while another is still being served leaves the claims' deadline standing: it is withdrawn when the last of them has ended", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 2, true);
    const stub = poolStub(projectId);
    const first = holder();
    const held = valueOf(WorkspacePoolCodecs.grant, await stub.grant(first));
    const claimArmed = async () =>
      (await alarmsOf(projectId)).armed.find((a) => a.reason === POOL_CLAIM);
    await vi.waitFor(async () => expect(await claimArmed()).toBeUndefined(), WAIT);
    // A second claim is being served: it waits on trunk for its head, and may yet relay.
    followed.head = commitSha("f");
    followed.headHeld = true;
    const second = stub.grant(holder());
    try {
      await vi.waitFor(async () => expect(await claimArmed()).toBeDefined(), WAIT);
      // The first holder asks again, and is answered at once with what it holds.
      const again = valueOf(WorkspacePoolCodecs.grant, await stub.grant(first));
      expect(again.workspaceId).toBe(held.workspaceId);
      expect(await statusOf(projectId)).toMatchObject({ refreshing: 0 });
      expect(await claimArmed()).toBeDefined();
    } finally {
      followed.headHeld = false;
    }
    expect(valueOf(WorkspacePoolCodecs.grant, await second).baseSha).toBe(followed.head);
    await vi.waitFor(
      async () => expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null }),
      WAIT,
    );
  });

  it("[pool.do.claim-deadline] a claim's deadline that comes due is answered by a refresh pass: with the workspace still mid-relay, the pass keeps itself armed until it is settled", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 1, true);
    const stub = poolStub(projectId);
    followed.head = commitSha("c");
    followed.held = true;
    const claim = stub.grant(holder());
    try {
      await vi.waitFor(() => expect(followed.relays).toHaveLength(1), WAIT);
      expect(await refreshArmed(projectId)).toBeUndefined();
      // The deadline comes due, as it would for an object that died under the relay.
      await runInDurableObject(stub, (_instance: WorkspacePoolDO, state) =>
        scheduleAlarm(state.storage, { kind: "deadline", reason: POOL_CLAIM, at: Date.now() }),
      );
      await runDurableObjectAlarm(stub);
      await vi.waitFor(async () => expect(await refreshArmed(projectId)).toBeDefined(), WAIT);
    } finally {
      followed.held = false;
    }
    expect(valueOf(WorkspacePoolCodecs.grant, await claim).baseSha).toBe(followed.head);
    // The workspace is its holder's now: the pass finds nothing left to settle and withdraws.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(stub);
        expect(await alarmsOf(projectId)).toEqual({ armed: [], alarm: null });
      },
      { timeout: 20_000, interval: 250 },
    );
  });

  it("[pool.do.claim-collects] a claim that gives a workspace up arms its collection: the claim answers PoolExhausted, never the workspace, and the workspace's repo is deleted", async () => {
    const projectId = freshProject();
    const followed = await stock(projectId, 1, true);
    const stub = poolStub(projectId);
    followed.head = commitSha("d");
    // What the workspace lacks is over the relay's cap: it can never follow trunk.
    followed.answer = "too-large";
    const refused = decodeExit(WorkspacePoolCodecs.grant, await stub.grant(holder()));
    expect(Exit.isFailure(refused) ? JSON.stringify(refused.cause) : "granted").toContain(
      "PoolExhausted",
    );
    expect(followed.relays).toHaveLength(1);
    const given = followed.relays[0]?.workspace ?? "";
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(await statusOf(projectId)).toMatchObject({ ready: 0, collecting: 0 });
      expect(await exists(given)).toBe(false);
    }, WAIT);
  });
});
