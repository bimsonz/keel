// The Lane DO in workerd: a delivered ChangeQueued arms the lane's step, the
// alarm takes the batch to Verifying, and recordVerdict through the RPC and
// the Exit envelope lands it or refuses a fenced verdict. The driven adapters
// are in memory, the backbone is the object's own storage.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  batchOf,
  laneHeard,
  laneOf,
  projectRepos,
  VERIFY_BUDGET_MS,
} from "@keeltown/core/application/integration";
import { CommitSha, EventEnvelope, Instant, makeId, type ProjectId } from "@keeltown/core/kernel";
import {
  CandidateBundles,
  Changes,
  CodeHost,
  EntityStore,
  EventOutbox,
  Lanes,
  PlanStore,
  type VerificationJob,
} from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeNamespaceUsageMemory,
  makePlacedProject,
  makePlanStoreMemory,
  sampleNamespace,
  makeProjectsMemory,
  makeStagingWriterMemory,
  makeTrunkWriterMemory,
  PORTS,
  suitePlan,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import {
  LANE_REOFFER,
  LANE_STEP,
  LANE_VERIFY,
  type LaneDO,
} from "../../src/adapters/driving/do/lane.ts";
import type { TrunkDO } from "../../src/adapters/driving/do/trunk.ts";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import { LanesRpc } from "../../src/adapters/driven/do-rpc/lanes.ts";
import { backbone, type LaneServices } from "../../src/composition/do.ts";
import { drainAfter, drainOutbox } from "./helpers.ts";
import { placedIn } from "./pool-harness.ts";
import { decodeExit, EventCodecs, LaneCodecs } from "../../src/rpc/index.ts";

const MAIN = "refs/heads/main";
const HOUR = 3_600_000;
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));

/** A Lane DO for a fresh project, running on in-memory driven adapters (the pool shares the isolate). */
async function lane(
  options: {
    readonly noStaging?: boolean;
    /** The candidate bundler, in place of one in memory that always bundles. */
    readonly bundles?: Layer.Layer<CandidateBundles>;
    /** The project's largest batch: 1 unless given. */
    readonly maxBatchSize?: number;
  } = {},
) {
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
        ManagedRuntime.make(
          Layer.mergeAll(
            backbone(state.storage),
            code.layer,
            writer.layer,
            placedIn(projectId).layer,
            makeNamespaceUsageMemory().layer,
          ),
        ),
      );
    });
    await trunk.initialize(base, "seed", { kind: "empty" });
  }
  const verification = makeBatchVerificationMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: [],
    maxBatchSize: options.maxBatchSize ?? 1,
    verification: "required",
    visibility: "private",
  });
  // The plan Precheck stored for every change this lane queues.
  const plans = makePlanStoreMemory();
  await Effect.runPromise(
    Effect.flatMap(PlanStore, (store) => store.put(sampleNamespace, PLAN)).pipe(
      Effect.provide(plans.layer),
    ),
  );
  const agentId = makeId("agt", ulid());
  const changes = Layer.succeed(
    Changes,
    Changes.of({
      adopt: () => Effect.die(new Error("the Lane never adopts")),
      rebase: () => Effect.die(new Error("the Lane never rebases")),
      commit: () => Effect.die(new Error("the Lane never commits")),
      refreshWorkspace: () => Effect.die(new Error("the Lane never refreshes a workspace")),
      revise: () => Effect.die(new Error("the Lane never revises")),
      rely: () => Effect.die(new Error("the Lane never relies")),
      distinguish: () => Effect.die(new Error("the Lane never distinguishes")),
      nearby: () => Effect.die(new Error("the Lane never reads nearby")),
      abandon: () => Effect.die(new Error("the Lane never abandons")),
      get: (id) =>
        Effect.succeed({
          change: {
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
          },
          projectId,
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
    plans.layer,
    changes,
    makeCandidateComposerMemory().layer,
    makeAgentDirectoryMemory().layer,
    options.bundles ?? makeCandidateBundlesMemory().layer,
    verification.layer,
    makeStagingWriterMemory({
      get: () => stagingRefs()?.get(MAIN),
      set: (to) => void stagingRefs()?.set(MAIN, to),
    }).layer,
    projects.layer,
    makePlacedProject(projectId).layer,
  );
  /** Gives the object its in-memory adapters: again after each eviction, as a fresh instance has its own. */
  const install = () =>
    runInDurableObject(stub, (instance: LaneDO, state) => {
      Reflect.set(
        instance,
        "runtime",
        ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
      );
    });
  await install();
  /** The candidate the composer pushed for `candidateId`: one commit a member, chained on staging's base at its ref. */
  const pushCandidate = async (candidateId: string, members = 1) => {
    const ref = `refs/heads/cand/${candidateId}`;
    if (base !== undefined) stagingRefs()?.set(ref, base);
    let tip: CommitSha | undefined;
    for (let n = 0; n < members; n++)
      tip = await Effect.runPromise(
        code.fixture.commit(staging, ref, {
          "README.md": "keel\n",
          [`src/member-${n}.ts`]: "export {};\n",
        }),
      );
    if (tip === undefined) throw new Error("a candidate has at least one member");
    return tip;
  };
  /** Every event the project's Trunk committed, in commit order. */
  const trunkEvents = () =>
    runInDurableObject(trunk, (_instance: TrunkDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "trunk", id: projectId })),
      ),
    );
  return { stub, projectId, laneId, verification, writer, pushCandidate, install, trunkEvents };
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

// The port's own suite, through the real object: a lane no change ever joined.
PORTS.Lanes.contract("do-rpc", () => LanesRpc(env.LANE));

describe("the Lane DO", () => {
  it("[lane.do.status] through the real object and the port a lane is shown the changes it holds: the one whose batch formed in flight, the two behind it still queued", async () => {
    const { stub, projectId, laneId, verification } = await lane();
    const view = () =>
      Effect.runPromise(
        Effect.flatMap(Lanes, (lanes) => lanes.view(projectId)).pipe(
          Effect.provide(LanesRpc(env.LANE)),
        ),
      );
    expect(await view()).toEqual([{ id: laneId, queued: 0, inFlight: 0 }]);
    await stub.receive([queued(laneId, 1), queued(laneId, 2), queued(laneId, 3)]);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    expect(await view()).toEqual([{ id: laneId, queued: 2, inFlight: 1 }]);
  });

  it("[lane.do.flow] a delivered ChangeQueued is batched by the lane's step; a fenced verdict is refused, and the right one lands through the Trunk", async () => {
    const { stub, laneId, verification, writer, pushCandidate } = await lane();
    const receipt = decodeExit(EventCodecs.receive, await stub.receive([queued(laneId, 1)]));
    expect(receipt).toEqual(Exit.succeed({ accepted: 1, duplicates: 0, ignored: 0 }));
    // The step is a debounce armed for now; the platform may run it before this line does.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    const [started] = [...verification.started.entries()];
    expect(started?.[0]).toMatch(/^keel-verify-prj_[0-9A-Z]{26}-main-evt_[0-9A-Z]{26}$/);
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

  it("[lane.do.group-commit] four queued changes form one batch, verified once on their plan, and one trunk advance lands all four, each at its own commit of the candidate's chain", async () => {
    const { stub, laneId, verification, writer, pushCandidate, trunkEvents } = await lane({
      maxBatchSize: 4,
    });
    await stub.receive([1, 2, 3, 4].map((n) => queued(laneId, n)));
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    const [[instanceId, job] = []] = [...verification.started.entries()];
    if (instanceId === undefined || job === undefined) throw new Error("KeelVerify never started");
    expect(job.members).toHaveLength(4);
    expect(job.planHash).toBe(PLAN.planHash);
    const tip = await pushCandidate(job.candidateId, 4);
    const landed = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict(landing(job, instanceId)),
    );
    expect(landed).toEqual(Exit.void);
    await vi.waitFor(
      async () => {
        expect(writer.head()).toBe(tip);
        expect(await batchState(stub, job.fence.batchId)).toBe("promoted");
      },
      { timeout: 20_000, interval: 50 },
    );
    const advanced = (await trunkEvents()).filter((event) => event.type === "TrunkAdvanced");
    expect(advanced).toHaveLength(1);
    const landings = Reflect.get(Object(advanced[0]?.payload), "landings");
    const commits = Array.isArray(landings)
      ? landings.map((l) => [
          Reflect.get(Object(l), "changeId"),
          Reflect.get(Object(l), "commitSha"),
        ])
      : [];
    expect(commits.map(([changeId]) => changeId)).toEqual(job.members);
    expect(new Set(commits.map(([, commitSha]) => commitSha)).size).toBe(4);
    expect(commits.at(-1)?.[1]).toBe(tip);
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

  it("[lane.do.destroy] a destroyed Lane cancels its deadlines, re-offers its green batch no more and forms nothing, through the Lanes adapter", async () => {
    const { stub, laneId, projectId, verification, writer, pushCandidate } = await lane();
    await stub.receive([queued(laneId, 1)]);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    const [[instanceId, job] = []] = [...verification.started.entries()];
    if (instanceId === undefined || job === undefined) throw new Error("KeelVerify never started");
    // Trunk never takes the green batch (its delivery is lost), so the lane owes it a re-offer.
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.unsubscribe(`trunk:${projectId}`)),
      ),
    );
    const tip = await pushCandidate(job.candidateId);
    expect(
      decodeExit(LaneCodecs.recordVerdict, await stub.recordVerdict(landing(job, instanceId))),
    ).toEqual(Exit.void);
    const laneDeadlines = () =>
      runInDurableObject(stub, (_instance: LaneDO, state) =>
        armedAlarms(state.storage)
          .map((a) => a.reason)
          .filter((reason) => [LANE_STEP, LANE_REOFFER, LANE_VERIFY].includes(reason)),
      );
    await vi.waitFor(async () => expect(await laneDeadlines()).toEqual([LANE_REOFFER]), {
      timeout: 10_000,
    });
    // A step backing off a failure is armed too, and so is the look at a verifying batch's instance.
    await runInDurableObject(stub, async (_instance: LaneDO, state) => {
      await scheduleAlarm(state.storage, {
        kind: "debounce",
        reason: LANE_STEP,
        at: Date.now() + 60_000,
      });
      await scheduleAlarm(state.storage, {
        kind: "deadline",
        reason: LANE_VERIFY,
        at: Date.now() + 60_000,
      });
    });
    const destroy = Effect.flatMap(Lanes, (lanes) => lanes.destroy(projectId, "operator"));
    await Effect.runPromise(destroy.pipe(Effect.provide(LanesRpc(env.LANE))));
    expect(await laneDeadlines()).toEqual([]);
    await Effect.runPromise(destroy.pipe(Effect.provide(LanesRpc(env.LANE))));
    // The re-offer's time comes all the same, and a change is queued late: nothing reaches trunk, nothing forms.
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      scheduleAlarm(state.storage, { kind: "deadline", reason: LANE_REOFFER, at: Date.now() }),
    );
    await runDurableObjectAlarm(stub);
    await stub.receive([queued(laneId, 2)]);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () => expect(await laneDeadlines()).toEqual([]), { timeout: 10_000 });
    expect(writer.head()).not.toBe(tip);
    expect(verification.started.size).toBe(1);
    expect(
      Exit.isFailure(
        decodeExit(LaneCodecs.recordVerdict, await stub.recordVerdict(landing(job, instanceId))),
      ),
    ).toBe(true);
    await drainOutbox(stub);
  });

  it("[lane.do.verify-armed] a verifying batch arms one deadline, for the end of its instance's budget; that deadline runs the lane's step; and a verdict clears it", async () => {
    const { stub, laneId, verification, pushCandidate } = await lane();
    const armedLook = () =>
      runInDurableObject(stub, (_instance: LaneDO, state) =>
        armedAlarms(state.storage).filter((a) => a.reason === LANE_VERIFY),
      );
    const before = Date.now();
    // The change is queued in the lane's own store, past the object's receive: no step is armed, so only the deadline under test can run one.
    const event = Schema.decodeUnknownSync(EventEnvelope)(queued(laneId, 1));
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.gen(function* () {
          const store = yield* EntityStore;
          const outbox = yield* EventOutbox;
          const at = Instant(0);
          store.transaction(
            () =>
              outbox.receive(event.dedupeKey, at) &&
              laneHeard({ store, outbox, at }, laneId, event),
          );
        }),
      ),
    );
    expect(
      await runInDurableObject(stub, (_instance: LaneDO, state) => armedAlarms(state.storage)),
    ).toEqual([]);
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      scheduleAlarm(state.storage, { kind: "deadline", reason: LANE_VERIFY, at: Date.now() }),
    );
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 5000 });
    const [[instanceId, job] = []] = [...verification.started.entries()];
    if (instanceId === undefined || job === undefined) throw new Error("KeelVerify never started");
    await vi.waitFor(
      async () => {
        const [armed, ...more] = await armedLook();
        expect(more).toEqual([]);
        expect(armed?.kind).toBe("deadline");
        expect(armed?.at).toBeGreaterThanOrEqual(before + VERIFY_BUDGET_MS);
        expect(armed?.at).toBeLessThanOrEqual(Date.now() + VERIFY_BUDGET_MS);
      },
      { timeout: 5000 },
    );
    await pushCandidate(job.candidateId);
    expect(
      decodeExit(LaneCodecs.recordVerdict, await stub.recordVerdict(landing(job, instanceId))),
    ).toEqual(Exit.void);
    await vi.waitFor(
      async () => {
        expect(await armedLook()).toEqual([]);
        expect(await batchState(stub, job.fence.batchId)).toBe("promoted");
      },
      { timeout: 20_000, interval: 50 },
    );
    await drainOutbox(stub);
  });

  it("[lane.do.instance-failed] the platform's report of an errored instance, through the Lanes adapter, fails its batch on the infrastructure and frees the lane for the next change; a report of an instance still running, or of another instance, changes nothing", async () => {
    const { stub, laneId, verification } = await lane();
    await stub.receive([queued(laneId, 1), queued(laneId, 2)]);
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 5000 });
    const [[instanceId, job] = []] = [...verification.started.entries()];
    if (instanceId === undefined || job === undefined) throw new Error("KeelVerify never started");
    const ended = Effect.flatMap(Lanes, (lanes) => lanes.verificationEnded(laneId, instanceId));
    await Effect.runPromise(ended.pipe(Effect.provide(LanesRpc(env.LANE))));
    expect(await batchState(stub, job.fence.batchId)).toBe("verifying");
    verification.end(instanceId, { _tag: "Failed", status: "errored", error: "not a job" });
    // A report that names another instance, an earlier batch's, is not this batch's: nothing is read for it.
    const stray = Effect.flatMap(Lanes, (lanes) =>
      lanes.verificationEnded(laneId, `${instanceId}-earlier`),
    );
    await Effect.runPromise(stray.pipe(Effect.provide(LanesRpc(env.LANE))));
    expect(verification.looked).toEqual([instanceId]);
    expect(await batchState(stub, job.fence.batchId)).toBe("verifying");
    await Effect.runPromise(ended.pipe(Effect.provide(LanesRpc(env.LANE))));
    expect(await batchState(stub, job.fence.batchId)).toBe("red");
    // The lane is free: the change behind gets a batch and an instance of its own.
    await vi.waitFor(() => expect(verification.started.size).toBe(2), { timeout: 5000 });
    const [, [, second] = []] = [...verification.started.entries()];
    expect(second?.fence.batchId).not.toBe(job.fence.batchId);
    await drainOutbox(stub);
  });

  it("[lane.do.step-failures] a bundle that throws in three steps is counted in the lane's storage past the object's eviction, with what it threw; the fourth step fails the batch on the infrastructure untried, and the step it arms at once bundles the next change", async () => {
    const calls = { count: 0 };
    const made = makeCandidateBundlesMemory();
    const bundles = Layer.effect(
      CandidateBundles,
      Effect.gen(function* () {
        const inner = yield* CandidateBundles;
        return CandidateBundles.of({
          bundle: (namespace, staging, commit, from) =>
            Effect.suspend(() => {
              calls.count += 1;
              return calls.count <= 3
                ? Effect.die(new RangeError("Array buffer allocation failed"))
                : inner.bundle(namespace, staging, commit, from);
            }),
        });
      }),
    ).pipe(Layer.provide(made.layer));
    const { stub, laneId, verification, install } = await lane({ bundles });
    // The changes are queued in the lane's own store, past the object's receive: no step is armed, so only the steps under test run.
    const events = [queued(laneId, 1), queued(laneId, 2)].map((e) =>
      Schema.decodeUnknownSync(EventEnvelope)(e),
    );
    await runInDurableObject(stub, (_instance: LaneDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.gen(function* () {
          const store = yield* EntityStore;
          const outbox = yield* EventOutbox;
          const at = Instant(0);
          for (const event of events)
            store.transaction(
              () =>
                outbox.receive(event.dedupeKey, at) &&
                laneHeard({ store, outbox, at }, laneId, event),
            );
        }),
      ),
    );
    const read = <A>(f: (store: (typeof EntityStore)["Service"]) => A) =>
      runInDurableObject(stub, (_instance: LaneDO, state) =>
        ManagedRuntime.make(backbone(state.storage)).runPromise(Effect.map(EntityStore, f)),
      );
    /** The lane's step, due now and run by its deadline, as the object's alarm runs it. */
    const step = async () => {
      await runInDurableObject(stub, (_instance: LaneDO, state) =>
        scheduleAlarm(state.storage, { kind: "debounce", reason: LANE_STEP, at: Date.now() - 1 }),
      );
      await runDurableObjectAlarm(stub);
    };
    const oom = "RangeError: Array buffer allocation failed";
    for (let n = 1; n <= 3; n += 1) {
      await step();
      // The platform may run the step before `step` does: wait for what this one recorded.
      await vi.waitFor(
        async () =>
          expect(await read((store) => laneOf(store, laneId)?.active)).toMatchObject({
            ...(n === 1 ? {} : { failed: Array.from({ length: n - 1 }, () => `bundle: ${oom}`) }),
            attempt: { stage: "bundle", error: oom },
          }),
        { timeout: 10_000, interval: 25 },
      );
      // The retry the failed step armed is moved out of the way: only `step` runs one here.
      await runInDurableObject(stub, (_instance: LaneDO, state) =>
        scheduleAlarm(state.storage, {
          kind: "debounce",
          reason: LANE_STEP,
          at: Date.now() + HOUR,
        }),
      );
      // The object is evicted after each failed step: what it counted is in its storage alone.
      await evictDurableObject(stub);
      await install();
    }
    expect(calls.count).toBe(3);
    await step();
    await vi.waitFor(
      async () =>
        expect(
          await read((store) => laneOf(store, laneId)?.infra.map((entry) => entry.reasons)),
        ).toEqual([[`step-failed x3: bundle: ${oom}; bundle: ${oom}; bundle: ${oom}`]]),
      { timeout: 10_000, interval: 25 },
    );
    // The step the object armed at once forms the next change's batch, bundles it and starts its verification.
    // The platform may run it before this line does, so the fourth step's bundle untried shows in the count after:
    // three failed bundles and the next change's one.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(stub);
        expect(verification.started.size).toBe(1);
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(calls.count).toBe(4);
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
