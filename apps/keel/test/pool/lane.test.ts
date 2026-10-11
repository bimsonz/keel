// The Lane DO in workerd: a delivered ChangeQueued arms the lane's step, the
// alarm takes the batch to Verifying, and recordVerdict through the RPC and
// the Exit envelope lands it or refuses a fenced verdict. The driven adapters
// are in memory, the backbone is the object's own storage.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { batchOf, projectRepos } from "@keeltown/core/application/integration";
import { CommitSha, Instant, makeId, type ProjectId } from "@keeltown/core/kernel";
import {
  Changes,
  CodeHost,
  EntityStore,
  EventOutbox,
  type VerificationJob,
} from "@keeltown/core/ports";
import {
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeProjectsMemory,
  makeStagingWriterMemory,
  makeTrunkWriterMemory,
  suitePlan,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { LANE_REOFFER, LANE_STEP, type LaneDO } from "../../src/adapters/driving/do/lane.ts";
import type { TrunkDO } from "../../src/adapters/driving/do/trunk.ts";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import { backbone, type LaneServices } from "../../src/composition/do.ts";
import { drainAfter, drainOutbox } from "./helpers.ts";
import { decodeExit, EventCodecs, LaneCodecs } from "../../src/rpc/index.ts";

const MAIN = "refs/heads/main";
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));

/** A Lane DO for a fresh project, running on in-memory driven adapters (the pool shares the isolate). */
async function lane(options: { readonly noStaging?: boolean } = {}) {
  const projectId: ProjectId = makeId("prj", ulid());
  const laneId = `lane:${projectId}:main`;
  const stub = drainAfter(env.LANE.get(env.LANE.idFromName(laneId)));
  const staging = projectRepos(projectId).staging;
  const code = makeCodeHostMemory();
  const base = await Effect.runPromise(
    Effect.gen(function* () {
      if (options.noStaging === true) return undefined;
      yield* (yield* CodeHost).create(staging);
      return yield* code.fixture.commit(staging, MAIN, { "README.md": "keel\n" });
    }).pipe(Effect.provide(code.layer)),
  );
  const stagingRefs = () => code.repos.get(`${staging.namespace}/${staging.name}`)?.refs;
  // The project's trunk, at staging's head, writing through memory: the lane's BatchVerified reaches it.
  const writer = makeTrunkWriterMemory(base ?? sha("0"));
  const trunk = drainAfter(env.TRUNK.get(env.TRUNK.idFromName(`trunk:${projectId}`)));
  if (base !== undefined) {
    await runInDurableObject(trunk, (instance: TrunkDO, state) => {
      Reflect.set(
        instance,
        "runtime",
        ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), code.layer, writer.layer)),
      );
    });
    await trunk.initialize(base, "seed");
  }
  const verification = makeBatchVerificationMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: "private",
  });
  const agentId = makeId("agt", ulid());
  const changes = Layer.succeed(
    Changes,
    Changes.of({
      adopt: () => Effect.die(new Error("the Lane never adopts")),
      rebase: () => Effect.die(new Error("the Lane never rebases")),
      revise: () => Effect.die(new Error("the Lane never revises")),
      rely: () => Effect.die(new Error("the Lane never relies")),
      nearby: () => Effect.die(new Error("the Lane never reads nearby")),
      abandon: () => Effect.die(new Error("the Lane never abandons")),
      get: (id) =>
        Effect.succeed({
          id,
          agentId,
          origin: "agent",
          state: "queued",
          intent: { revision: 1, goal: `goal of ${id}`, footprint: [], premises: [] },
          lease: { id: makeId("lse", ulid()), agentId, renewedAt: Instant(0), state: "active" },
          createdAt: Instant(0),
          baseSha: sha("0"),
          commitSha: sha("c"),
          laneId,
        }),
      workspace: (id) =>
        Effect.succeed({
          workspaceId: makeId("wsp", ulid()),
          repo: { namespace: "memory", name: `ws-${id}` },
          baseSha: sha("0"),
          grantedSha: sha("0"),
          projectId,
        }),
      declare: () => Effect.die(new Error("the Lane never declares")),
      submit: () => Effect.die(new Error("the Lane never submits")),
      awaitSubmission: () => Effect.die(new Error("the Lane never waits on a submission")),
    }),
  );
  const driven: Layer.Layer<LaneServices> = Layer.mergeAll(
    code.layer,
    changes,
    makeCandidateComposerMemory().layer,
    makeCandidateBundlesMemory().layer,
    verification.layer,
    makeStagingWriterMemory({
      get: () => stagingRefs()?.get(MAIN),
      set: (to) => void stagingRefs()?.set(MAIN, to),
    }).layer,
    projects.layer,
  );
  await runInDurableObject(stub, (instance: LaneDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
    );
  });
  /** The candidate the composer pushed for `candidateId`: a commit on staging's base at its ref. */
  const pushCandidate = (candidateId: string) => {
    const ref = `refs/heads/cand/${candidateId}`;
    if (base !== undefined) stagingRefs()?.set(ref, base);
    return Effect.runPromise(
      code.fixture.commit(staging, ref, { "README.md": "keel\n", "src/retry.ts": "export {};\n" }),
    );
  };
  return { stub, projectId, laneId, verification, writer, pushCandidate };
}

/** The plan each queued change was compiled with, as its ChangeQueued names it. */
const PLAN = suitePlan();

const queued = (laneId: string, n: number) => {
  const changeId = makeId("chg", ulid());
  return {
    eventId: makeId("evt", ulid()),
    type: "ChangeQueued",
    entity: { kind: "change", id: changeId },
    seq: n,
    at: Date.now(),
    dedupeKey: `change:${changeId}/plan/ChangeQueued#1`,
    affected: [],
    notified: [laneId],
    payload: { _tag: "ChangeQueued", changeId, laneId, planHash: PLAN.planHash },
  };
};

/** KeelVerify's report on the batch: `land`, for the fence's `attempt`. */
const landing = (job: VerificationJob, instanceId: string, attempt = 0) => ({
  instanceId,
  fence: { ...job.fence, attempt },
  candidateId: job.candidateId,
  verdictId: makeId("vrd", ulid()),
  outcome: "land",
  planHash: PLAN.planHash,
  evidence: ["suite: 12 passed"],
  failingTests: [],
});

/** The batch's state, as the Lane DO holds it. */
const batchState = (
  stub: DurableObjectStub<LaneDO>,
  batchId: VerificationJob["fence"]["batchId"],
) =>
  runInDurableObject(stub, (_instance: LaneDO, state) =>
    ManagedRuntime.make(backbone(state.storage)).runPromise(
      Effect.map(EntityStore, (store) => batchOf(store, batchId)?.state),
    ),
  );

describe("the Lane DO", () => {
  it("[lane.do.flow] a delivered ChangeQueued is batched by the lane's step; a fenced verdict is refused, and the right one lands through the Trunk", async () => {
    const { stub, laneId, verification, writer, pushCandidate } = await lane();
    const receipt = decodeExit(EventCodecs.receive, await stub.receive([queued(laneId, 1)]));
    expect(receipt).toEqual(Exit.succeed({ accepted: 1, duplicates: 0, ignored: 0 }));
    // The step is a debounce armed for now; the platform may run it before this line does.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    const [started] = [...verification.started.entries()];
    expect(started?.[0]).toMatch(/^keel-verify-evt_/);
    const job = started?.[1];
    if (job === undefined) throw new Error("KeelVerify never started");
    const fenced = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict(landing(job, "old", 1)),
    );
    expect(Exit.isFailure(fenced) ? JSON.stringify(fenced.cause) : "success").toContain(
      "ResultFenced",
    );
    const tip = await pushCandidate(job.candidateId);
    const landed = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict(landing(job, started?.[0] ?? "")),
    );
    expect(landed).toEqual(Exit.void);
    // BatchVerified reaches the Trunk, which lands the candidate; its TrunkAdvanced promotes the batch.
    await vi.waitFor(
      async () => {
        expect(writer.head()).toBe(tip);
        expect(await batchState(stub, job.fence.batchId)).toBe("promoted");
      },
      { timeout: 20_000, interval: 50 },
    );
    // The step and the verdicts committed real events; their flush must not outlive the file.
    await drainOutbox(stub);
  });

  it("[lane.do.reoffer] a BatchVerified trunk never took is re-offered on the lane's deadline, and lands", async () => {
    const { stub, laneId, projectId, verification, writer, pushCandidate } = await lane();
    await stub.receive([queued(laneId, 1)]);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    const [[instanceId, job] = []] = [...verification.started.entries()];
    if (instanceId === undefined || job === undefined) throw new Error("KeelVerify never started");
    // The delivery is lost, as the Trunk deployed before promotion spent it: trunk is owed nothing.
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.unsubscribe(`trunk:${projectId}`)),
      ),
    );
    const tip = await pushCandidate(job.candidateId);
    const verifiedAt = Date.now();
    expect(
      decodeExit(LaneCodecs.recordVerdict, await stub.recordVerdict(landing(job, instanceId))),
    ).toEqual(Exit.void);
    const armedReoffer = () =>
      runInDurableObject(stub, (_instance: LaneDO, state) =>
        armedAlarms(state.storage).find((a) => a.reason === LANE_REOFFER),
      );
    // The step after the verdict arms the re-offer 30 s after BatchVerified.
    await vi.waitFor(
      async () => {
        const armed = await armedReoffer();
        expect(armed?.at).toBeGreaterThanOrEqual(verifiedAt + 30_000);
        expect(armed?.at).toBeLessThanOrEqual(Date.now() + 30_000);
      },
      { timeout: 10_000 },
    );
    expect(writer.head()).not.toBe(tip);
    // Its time comes now.
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      scheduleAlarm(state.storage, { kind: "deadline", reason: LANE_REOFFER, at: Date.now() }),
    );
    await runDurableObjectAlarm(stub);
    await vi.waitFor(
      async () => {
        expect(writer.head()).toBe(tip);
        expect(await batchState(stub, job.fence.batchId)).toBe("promoted");
        // Trunk answered, so nothing is re-offered any more.
        expect(await armedReoffer()).toBeUndefined();
      },
      { timeout: 20_000, interval: 50 },
    );
    await drainOutbox(stub);
  });

  it("[lane.do.backoff] a step that keeps failing is retried 1 s·2ⁿ later, not on a fixed loop", async () => {
    // No staging repo: every step dies reading staging's head.
    const { stub, laneId } = await lane({ noStaging: true });
    const armedStep = () =>
      runInDurableObject(stub, (_instance: LaneDO, state) =>
        armedAlarms(state.storage).find((a) => a.reason === LANE_STEP),
      );
    const before = Date.now();
    await stub.receive([queued(laneId, 1)]);
    // The step is a debounce armed for now; the platform may run it before this line does.
    await runDurableObjectAlarm(stub);
    // Each failure re-arms the step from when it ran; the platform runs each alarm when it comes due.
    const armed: number[] = [];
    await vi.waitFor(
      async () => {
        const at = (await armedStep())?.at;
        if (at !== undefined && at > before + 500 && !armed.includes(at)) armed.push(at);
        expect(armed.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 20_000, interval: 25 },
    );
    // A failure runs no earlier than its alarm, so each wait is measured from at least the last
    // one's time, however late the platform ran it: 1 s, then 2 s, then 4 s (ADR 0009's backoff).
    const [first = 0, second = 0, third = 0] = armed;
    expect(first - before).toBeGreaterThanOrEqual(1_000);
    expect(second - first).toBeGreaterThanOrEqual(2_000);
    expect(third - second).toBeGreaterThanOrEqual(4_000);
  });

  it("[lane.do.composition] the lane's own composition builds from the Worker's bindings", async () => {
    const laneId = `lane:${makeId("prj", ulid())}:main`;
    const stub = env.LANE.get(env.LANE.idFromName(laneId));
    const unknown = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict({
        instanceId: "keel-verify-none",
        fence: { batchId: makeId("bat", ulid()), attempt: 0, chainEpoch: 0 },
        candidateId: makeId("cnd", ulid()),
        verdictId: makeId("vrd", ulid()),
        outcome: "land",
        planHash: PLAN.planHash,
        evidence: [],
        failingTests: [],
      }),
    );
    expect(Exit.isFailure(unknown) ? JSON.stringify(unknown.cause) : "success").toContain(
      "CandidateNotFound",
    );
  });
});
