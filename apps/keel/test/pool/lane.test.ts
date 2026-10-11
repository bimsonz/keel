// The Lane DO in workerd: a delivered ChangeQueued arms the lane's step, the
// alarm takes the batch to Verifying, and recordVerdict through the RPC and
// the Exit envelope lands it or refuses a fenced verdict. The driven adapters
// are in memory, the backbone is the object's own storage.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { batchOf, projectRepos } from "@keeltown/core/application/integration";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import { CommitSha, Instant, makeId, type ProjectId } from "@keeltown/core/kernel";
import { Changes, CodeHost, EntityStore } from "@keeltown/core/ports";
import {
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeProjectsMemory,
  makeStagingWriterMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { LaneDO } from "../../src/adapters/driving/do/lane.ts";
import { backbone, type LaneServices } from "../../src/composition/do.ts";
import { drainOutbox } from "./helpers.ts";
import { decodeExit, EventCodecs, LaneCodecs } from "../../src/rpc/index.ts";

const MAIN = "refs/heads/main";
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));

/** A Lane DO for a fresh project, running on in-memory driven adapters (the pool shares the isolate). */
async function lane() {
  const projectId: ProjectId = makeId("prj", ulid());
  const laneId = `lane:${projectId}:main`;
  const stub = env.LANE.get(env.LANE.idFromName(laneId));
  const staging = projectRepos(projectId).staging;
  const code = makeCodeHostMemory();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(staging);
      yield* code.fixture.commit(staging, MAIN, { "README.md": "keel\n" });
    }).pipe(Effect.provide(code.layer)),
  );
  const verification = makeBatchVerificationMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
  });
  const agentId = makeId("agt", ulid());
  const changes = Layer.succeed(
    Changes,
    Changes.of({
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
    makeStagingWriterMemory().layer,
    projects.layer,
  );
  await runInDurableObject(stub, (instance: LaneDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
    );
  });
  return { stub, projectId, laneId, verification };
}

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
    payload: { _tag: "ChangeQueued", changeId, laneId },
  };
};

describe("the Lane DO", () => {
  it("[lane.do.flow] a delivered ChangeQueued is batched by the lane's step; a fenced verdict is refused and the right one lands", async () => {
    const { stub, laneId, verification } = await lane();
    const receipt = decodeExit(EventCodecs.receive, await stub.receive([queued(laneId, 1)]));
    expect(receipt).toEqual(Exit.succeed({ accepted: 1, duplicates: 0, ignored: 0 }));
    // The step is a debounce armed for now; the platform may run it before this line does.
    await runDurableObjectAlarm(stub);
    await vi.waitFor(() => expect(verification.started.size).toBe(1), { timeout: 10_000 });
    const [started] = [...verification.started.entries()];
    expect(started?.[0]).toMatch(/^keel-verify-evt_/);
    const job = started?.[1];
    if (job === undefined) throw new Error("KeelVerify never started");
    const command = (attempt: number, instanceId: string) => ({
      instanceId,
      fence: { ...job.fence, attempt },
      candidateId: job.candidateId,
      verdictId: makeId("vrd", ulid()),
      outcome: "land",
      planHash: L1_SUITE_PLAN.planHash,
      evidence: ["suite: 12 passed"],
      failingTests: [],
    });
    const fenced = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict(command(1, "old")),
    );
    expect(Exit.isFailure(fenced) ? JSON.stringify(fenced.cause) : "success").toContain(
      "ResultFenced",
    );
    const landed = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict(command(0, started?.[0] ?? "")),
    );
    expect(landed).toEqual(Exit.void);
    const batch = await runInDurableObject(stub, (_instance: LaneDO, state) =>
      ManagedRuntime.make(backbone(state.storage)).runPromise(
        Effect.map(EntityStore, (store) => batchOf(store, job.fence.batchId)?.state),
      ),
    );
    expect(batch).toBe("green");
    // The step and the verdicts committed real events; their flush must not outlive the file.
    await drainOutbox(stub);
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
        planHash: L1_SUITE_PLAN.planHash,
        evidence: [],
        failingTests: [],
      }),
    );
    expect(Exit.isFailure(unknown) ? JSON.stringify(unknown.cause) : "success").toContain(
      "CandidateNotFound",
    );
  });
});
