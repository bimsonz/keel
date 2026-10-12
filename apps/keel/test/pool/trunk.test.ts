// The Trunk DO in workerd, through its RPC and the Exit envelope. Its
// promotion runs on in-memory driven adapters (a trunk writer and a code host
// holding staging), swapped into the object's runtime: the backbone, the
// deliveries and the alarms are the object's own.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { projectRepos } from "@keeltown/core/application/integration";
import {
  CommitSha,
  EventEnvelope,
  makeId,
  type OrgId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { Changes, CodeHost, EventOutbox, OrgUsage, Trunks } from "@keeltown/core/ports";
import {
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  freshOrg,
  makeCodeHostMemory,
  makeOrgUsageMemory,
  makeProjectsMemory,
  makeStagingWriterMemory,
  makeTrunkWriterMemory,
} from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { TrunksRpc } from "../../src/adapters/driven/do-rpc/trunks.ts";
import type { LaneDO } from "../../src/adapters/driving/do/lane.ts";
import type { TrunkDO } from "../../src/adapters/driving/do/trunk.ts";
import { backbone, type LaneServices } from "../../src/composition/do.ts";
import { decodeExit, EventCodecs, TrunkCodecs } from "../../src/rpc/index.ts";
import { drainAfter } from "./helpers.ts";
import { placedIn } from "./pool-harness.ts";

const MAIN = "refs/heads/main";
const WAIT = { timeout: 20_000, interval: 50 };

// Each trunk's events owe the Projector a delivery, drained after every case.
const trunkStub = (projectId: string) =>
  drainAfter(env.TRUNK.get(env.TRUNK.idFromName(`trunk:${projectId}`)));

/** Runs a program against the Trunks port over the Trunk DO's RPC. */
const viaTrunks = <A, E>(program: Effect.Effect<A, E, Trunks>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(TrunksRpc(env.TRUNK))));

/**
 * A fresh project's Trunk DO with memory adapters in its runtime: a trunk
 * writer at `head`, and the project's place in an org of its own, which
 * `initialize` reads before it names a head and counts the history into.
 */
async function placedTrunk(head: string) {
  const projectId: ProjectId = makeId("prj", ulid());
  const stub = trunkStub(projectId);
  await runInDurableObject(stub, (instance: TrunkDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          makeCodeHostMemory().layer,
          makeTrunkWriterMemory(Schema.decodeUnknownSync(CommitSha)(head)).layer,
          placedIn(projectId, freshOrg()).layer,
          makeOrgUsageMemory().layer,
        ),
      ),
    );
  });
  return { projectId, stub };
}

describe("the Trunk DO", () => {
  it("[trunk.do.init] initialize names trunk's first head once; a retry answers it, another head is refused", async () => {
    const head = "a".repeat(40);
    const { stub } = await placedTrunk(head);
    const first = decodeExit(TrunkCodecs.initialize, await stub.initialize(head, "seed"));
    expect(first).toEqual(Exit.succeed({ head, promotion: "idle", redCount: 0 }));
    const again = decodeExit(TrunkCodecs.initialize, await stub.initialize(head, "seed"));
    expect(again).toEqual(first);
    const other = decodeExit(TrunkCodecs.initialize, await stub.initialize("b".repeat(40), "seed"));
    expect(Exit.isFailure(other) ? JSON.stringify(other.cause) : "succeeded").toContain(
      "PromotionStateRefused",
    );
  });

  it("[trunks.rpc.initialize] the Trunks port reaches trunk:<projectId>: a retry is a no-op, another head is refused", async () => {
    const head = Schema.decodeUnknownSync(CommitSha)("c".repeat(40));
    const { projectId } = await placedTrunk(head);
    const initialize = (sha: CommitSha) =>
      viaTrunks(Effect.flatMap(Trunks, (trunks) => trunks.initialize(projectId, sha, "seed")));
    expect(await initialize(head)).toEqual(Exit.void);
    expect(await initialize(head)).toEqual(Exit.void);
    const other = await initialize(Schema.decodeUnknownSync(CommitSha)("d".repeat(40)));
    expect(Exit.isFailure(other) ? JSON.stringify(other.cause) : "succeeded").toContain(
      "PromotionStateRefused",
    );
    const trunk = decodeExit(
      TrunkCodecs.initialize,
      await trunkStub(projectId).initialize(head, "seed"),
    );
    expect(trunk).toEqual(Exit.succeed({ head, promotion: "idle", redCount: 0 }));
  });

  it("[trunks.rpc.head] the Trunks port reads trunk's head as its Trunk DO records it", async () => {
    const head = Schema.decodeUnknownSync(CommitSha)("e".repeat(40));
    const { projectId } = await placedTrunk(head);
    await viaTrunks(Effect.flatMap(Trunks, (trunks) => trunks.initialize(projectId, head, "seed")));
    expect(await viaTrunks(Effect.flatMap(Trunks, (trunks) => trunks.head(projectId)))).toEqual(
      Exit.succeed(head),
    );
  });

  it("[trunk.do.no-org] the real object, reading D1, gives a project with no place no trunk: initialize answers a defect that names it", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    const stub = trunkStub(projectId);
    const refused = decodeExit(
      TrunkCodecs.initialize,
      await stub.initialize("a".repeat(40), "seed"),
    );
    expect(Exit.isFailure(refused) ? Cause.pretty(refused.cause) : "succeeded").toContain(
      `project ${projectId} has no place`,
    );
    const status = decodeExit(TrunkCodecs.status, await stub.status());
    expect(Exit.isFailure(status) ? Cause.pretty(status.cause) : "succeeded").toContain(
      "is not initialized",
    );
  });
});

/**
 * A Trunk DO for a fresh project, initialized at staging's one commit,
 * promoting through memory adapters. The project is placed in an org before
 * its trunk is initialized: `placed` names that org and what its history
 * weighs, for a test that reads the org's count.
 */
async function promoting(placed?: { readonly org: OrgId; readonly history: number }) {
  const projectId: ProjectId = makeId("prj", ulid());
  const stub = trunkStub(projectId);
  const staging = projectRepos(projectId).staging;
  const code = makeCodeHostMemory();
  const writer = makeTrunkWriterMemory(Schema.decodeUnknownSync(CommitSha)("0".repeat(40)));
  const run = <A>(program: Effect.Effect<A, unknown, CodeHost>) =>
    Effect.runPromise(program.pipe(Effect.provide(code.layer)));
  const base = await run(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(staging);
      return yield* code.fixture.commit(staging, MAIN, { "README.md": "keel\n" });
    }),
  );
  writer.interfere(base);
  const places = placedIn(projectId, placed?.org ?? freshOrg());
  const usage = makeOrgUsageMemory();
  if (placed !== undefined) writer.holds(base, placed.history);
  await runInDurableObject(stub, (instance: TrunkDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          code.layer,
          writer.layer,
          places.layer,
          usage.layer,
        ),
      ),
    );
  });
  // The lane hears every advance and decline; it follows trunk in the same memory staging.
  const stagingRefs = () => code.repos.get(`${staging.namespace}/${staging.name}`)?.refs;
  const laneServices: Layer.Layer<LaneServices> = Layer.mergeAll(
    code.layer,
    Layer.succeed(
      Changes,
      Changes.of({
        adopt: () => Effect.die(new Error("the Lane never adopts")),
        rebase: () => Effect.die(new Error("the Lane never rebases")),
        revise: () => Effect.die(new Error("the Lane never revises")),
        rely: () => Effect.die(new Error("the Lane never relies")),
        nearby: () => Effect.die(new Error("the Lane never reads nearby")),
        abandon: () => Effect.die(new Error("the Lane never abandons")),
        get: () => Effect.die(new Error("no change is queued in a trunk test")),
        workspace: () => Effect.die(new Error("no change is queued in a trunk test")),
        declare: () => Effect.die(new Error("the Lane never declares")),
        submit: () => Effect.die(new Error("the Lane never submits")),
        awaitSubmission: () => Effect.die(new Error("the Lane never waits on a submission")),
      }),
    ),
    makeCandidateComposerMemory().layer,
    makeCandidateBundlesMemory().layer,
    makeBatchVerificationMemory().layer,
    makeStagingWriterMemory({
      get: () => stagingRefs()?.get(MAIN),
      set: (to) => void stagingRefs()?.set(MAIN, to),
    }).layer,
    makeProjectsMemory().layer,
  );
  const lane = drainAfter(env.LANE.get(env.LANE.idFromName(`lane:${projectId}:main`)));
  await runInDurableObject(lane, (instance: LaneDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), laneServices)),
    );
  });
  expect(decodeExit(TrunkCodecs.initialize, await stub.initialize(base, "seed"))).toEqual(
    Exit.succeed({ head: base, promotion: "idle", redCount: 0 }),
  );
  /** Change `n`'s candidate on `on`, at refs/heads/cand/<cid> in staging. */
  const composed = (n: number, on: CommitSha) => {
    const ref = `refs/heads/cand/${candidateOf(projectId, n)}`;
    code.repos.get(`${staging.namespace}/${staging.name}`)?.refs.set(ref, on);
    return run(
      code.fixture.commit(staging, ref, {
        "README.md": "keel\n",
        [`src/change-${n}.ts`]: `export const n = ${n};\n`,
      }),
    );
  };
  /** Batch `n`'s BatchVerified, a batch of one verified on `on`, as the Lane committed it. */
  const verified = (n: number, on: CommitSha) =>
    Schema.encodeSync(EventEnvelope)(
      Schema.decodeUnknownSync(EventEnvelope)({
        eventId: makeId("evt", ulid()),
        type: "BatchVerified",
        entity: { kind: "batch", id: batchOf(projectId, n) },
        seq: 3,
        at: Date.now(),
        dedupeKey: `batch:${batchOf(projectId, n)}/verdict/BatchVerified#1`,
        affected: [{ kind: "change", id: changeOf(projectId, n) }],
        notified: [`trunk:${projectId}`],
        payload: {
          _tag: "BatchVerified",
          batchId: batchOf(projectId, n),
          candidateId: candidateOf(projectId, n),
          verdictId: makeId("vrd", ulid()),
          members: [changeOf(projectId, n)],
          base: on,
        },
      }),
    );
  const status = async () => decodeExit(TrunkCodecs.status, await stub.status());
  /** Trunk's own events, read inside the object. */
  const log = () =>
    runInDurableObject(stub, (instance: TrunkDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "trunk", id: projectId })),
      ),
    );
  /** Runs the object's alarms until `settled` holds: the debounce, pushes and the mirror's sync. */
  const until = (settled: () => Promise<void>) =>
    vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      await settled();
    }, WAIT);
  return { projectId, stub, code, writer, usage, base, composed, verified, status, log, until };
}

// Per-project ids, so the isolate's shared memory never mixes two tests' batches.
const suffix = (projectId: ProjectId, n: number) =>
  `${projectId.slice(4, 20)}${String(n).padStart(10, "0")}`;
const batchOf = (projectId: ProjectId, n: number) => makeId("bat", suffix(projectId, n));
const candidateOf = (projectId: ProjectId, n: number) => makeId("cnd", suffix(projectId, n));
const changeOf = (projectId: ProjectId, n: number) => makeId("chg", suffix(projectId, n));

describe("the Trunk DO's promotion", () => {
  it("[trunk.do.racers] ten BatchVerified delivered concurrently, each twice: trunk advances exactly as its WAL says, once, and declines the rest", async () => {
    const t = await promoting();
    const tips: CommitSha[] = [];
    for (let n = 1; n <= 10; n++) tips.push(await t.composed(n, t.base));
    const events = Array.from({ length: 10 }, (_, i) => t.verified(i + 1, t.base));
    const receipts = await Promise.all(
      [...events, ...events].map(async (e) =>
        decodeExit(EventCodecs.receive, await t.stub.receive([e])),
      ),
    );
    const accepted = receipts.flatMap((r) => (Exit.isSuccess(r) ? [r.value.accepted] : []));
    expect(accepted.reduce((a, b) => a + b, 0)).toBe(10);
    await t.until(async () => {
      const types = (await t.log()).map((e) => e.type);
      expect(types.filter((x) => x === "PromotionDeclined")).toHaveLength(9);
      expect(await t.status()).toEqual(
        Exit.succeed({ head: tips[0], promotion: "idle", redCount: 0 }),
      );
    });
    const log = await t.log();
    const started = log.filter((e) => e.type === "PromotionStarted");
    const advanced = log.filter((e) => e.type === "TrunkAdvanced");
    expect(started).toHaveLength(1);
    expect(advanced.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        from: t.base,
        to: tips[0],
        groupId: expect.stringMatching(new RegExp(`^${batchOf(t.projectId, 1)}@`)),
      }),
    ]);
    expect(t.writer.pushes()).toEqual([{ from: t.base, to: tips[0] }]);
    expect(t.writer.head()).toBe(tips[0]);
  });

  it("[trunk.do.freeze] an injected stale head freezes promotion through the real object, and nothing is pushed", async () => {
    const t = await promoting();
    await t.composed(1, t.base);
    const stale = Schema.decodeUnknownSync(CommitSha)("e".repeat(40));
    t.writer.interfere(stale);
    await t.stub.receive([t.verified(1, t.base)]);
    await t.until(async () =>
      expect(await t.status()).toEqual(
        Exit.succeed({ head: t.base, promotion: "frozen", redCount: 0 }),
      ),
    );
    expect((await t.log()).at(-1)?.payload).toMatchObject({
      _tag: "PromotionFrozen",
      expected: t.base,
      observed: stale,
    });
    expect(t.writer.pushes()).toEqual([]);
  });

  it("[trunk.do.resume] the operator's resume releases the freeze at trunk's head, and the next batch on it lands", async () => {
    const t = await promoting();
    await t.composed(1, t.base);
    // Someone else's commit reached trunk before batch 1 could.
    const moved = await t.composed(9, t.base);
    t.writer.interfere(moved);
    await t.stub.receive([t.verified(1, t.base)]);
    await t.until(async () =>
      expect(await t.status()).toEqual(
        Exit.succeed({ head: t.base, promotion: "frozen", redCount: 0 }),
      ),
    );
    expect(decodeExit(TrunkCodecs.resume, await t.stub.resume("operator:zach"))).toEqual(
      Exit.succeed({ head: moved, promotion: "debouncing", redCount: 0 }),
    );
    // Batch 1 waited on the old head: it is declined, and batch 2, verified on the new one, lands.
    const tip = await t.composed(2, moved);
    await t.stub.receive([t.verified(2, moved)]);
    await t.until(async () =>
      expect(await t.status()).toEqual(Exit.succeed({ head: tip, promotion: "idle", redCount: 0 })),
    );
    const types = (await t.log()).map((e) => e.type);
    expect(types.slice(types.indexOf("PromotionResumed"))).toEqual([
      "PromotionResumed",
      "PromotionDeclined",
      "PromotionStarted",
      "PromotionComposed",
      "TrunkAdvanced",
    ]);
    expect(t.writer.pushes()).toEqual([{ from: moved, to: tip }]);
  });

  it("[trunk.do.refused-too-large] a batch whose pack is over the cap is declined through the real object, and the batch delivered behind it lands", async () => {
    const t = await promoting();
    const big = await t.composed(1, t.base);
    const tip = await t.composed(2, t.base);
    t.writer.weigh(big, 61 * 1024 * 1024);
    await t.stub.receive([t.verified(1, t.base)]);
    await t.until(async () =>
      expect((await t.log()).map((e) => e.type)).toContain("PromotionDeclined"),
    );
    expect(await t.status()).toMatchObject(Exit.succeed({ head: t.base }));
    await t.stub.receive([t.verified(2, t.base)]);
    await t.until(async () =>
      expect(await t.status()).toEqual(Exit.succeed({ head: tip, promotion: "idle", redCount: 0 })),
    );
    const log = await t.log();
    expect(log.map((e) => e.type)).not.toContain("PromotionFrozen");
    expect(log.find((e) => e.type === "PromotionDeclined")?.payload).toMatchObject({
      reason: "pack-too-large",
    });
    expect(t.writer.head()).toBe(tip);
  });

  it("[trunk.do.refused-quota] through the real object a project's history and each landing are counted into its org, and a batch over what is left is declined while a smaller one behind it lands", async () => {
    const org = freshOrg();
    const t = await promoting({ org, history: 1_000 });
    const counting = <A, E>(
      program: (usage: (typeof OrgUsage)["Service"]) => Effect.Effect<A, E>,
    ) => Effect.runPromise(Effect.flatMap(OrgUsage, program).pipe(Effect.provide(t.usage.layer)));
    // The history counted at create leaves room for 500 bytes more.
    await counting((usage) =>
      usage.configure(org, { overrides: { "repo-bytes": 1_500 }, halted: false }),
    );
    const big = await t.composed(1, t.base);
    const tip = await t.composed(2, t.base);
    t.writer.weigh(big, 533);
    t.writer.weigh(tip, 332);
    await t.stub.receive([t.verified(1, t.base)]);
    await t.until(async () =>
      expect((await t.log()).map((e) => e.type)).toContain("PromotionDeclined"),
    );
    expect(await t.status()).toMatchObject(Exit.succeed({ head: t.base }));
    expect(t.writer.pushes()).toEqual([]);
    await t.stub.receive([t.verified(2, t.base)]);
    await t.until(async () =>
      expect(await t.status()).toEqual(Exit.succeed({ head: tip, promotion: "idle", redCount: 0 })),
    );
    const log = await t.log();
    expect(log.map((e) => e.type)).not.toContain("PromotionFrozen");
    expect(log.find((e) => e.type === "PromotionDeclined")?.payload).toMatchObject({
      reason: "repo-bytes-quota",
    });
    // The create's 1,000 and the landing's 300: 200 are left of 1,500.
    expect(await counting((usage) => usage.admit(org, "repo-bytes", 0, "probe"))).toEqual({
      limit: 1_500,
      remaining: 200,
    });
  });

  it("[destroy.resumes] a destroyed trunk deletes its project's four repos, trying a failed deletion again until none is left, and promotes nothing meanwhile", async () => {
    const t = await promoting();
    const repos = Object.values(projectRepos(t.projectId));
    await Effect.runPromise(
      Effect.forEach(repos, (repo) =>
        Effect.flatMap(CodeHost, (host) => Effect.ignore(host.create(repo))),
      ).pipe(Effect.provide(t.code.layer)),
    );
    expect(t.code.repos.size).toBe(4);
    // The host fails the mirror's first deletion, as an outage would.
    const mirror = projectRepos(t.projectId).mirror.name;
    const mirrorDeletions: string[] = [];
    const flaky = Layer.effect(
      CodeHost,
      Effect.gen(function* () {
        const inner = yield* CodeHost;
        return CodeHost.of({
          ...inner,
          delete: (repo) => {
            if (repo.name !== mirror) return inner.delete(repo);
            mirrorDeletions.push(mirrorDeletions.length === 0 ? "failed" : "deleted");
            return mirrorDeletions.length === 1
              ? Effect.die(new Error("the host did not answer"))
              : inner.delete(repo);
          },
        });
      }),
    ).pipe(Layer.provide(t.code.layer));
    await runInDurableObject(t.stub, (instance: TrunkDO, state) => {
      Reflect.set(
        instance,
        "runtime",
        ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), flaky, t.writer.layer)),
      );
    });

    expect(decodeExit(TrunkCodecs.destroy, await t.stub.destroy("user:owner"))).toEqual(Exit.void);
    expect(decodeExit(TrunkCodecs.destroy, await t.stub.destroy("user:owner"))).toEqual(Exit.void);
    // A batch verified before the project went: delivered now, it is never queued or pushed.
    await t.stub.receive([t.verified(1, t.base)]);
    await t.until(async () => expect(t.code.repos.size).toBe(0));
    expect(mirrorDeletions).toEqual(["failed", "deleted"]);
    expect(await t.status()).toEqual(
      Exit.succeed({ head: t.base, promotion: "idle", redCount: 0 }),
    );
    expect((await t.log()).map((e) => e.type)).toEqual(["TrunkInitialized"]);
    expect(t.writer.pushes()).toEqual([]);
  });
});
