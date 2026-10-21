// The project's real Lane and Trunk DOs in workerd, on in-memory driven
// adapters, reading their members from the changes' real Change DOs: the
// harness the pool cases share where a change moves through its lane.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { laneOf } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import type { StepCount } from "@keeltown/core/domain/verification";
import { makeId, type NextAction, type ProjectId } from "@keeltown/core/kernel";
import {
  CodeHost,
  EventOutbox,
  type HumanGate,
  type ProjectNamespaces,
  type VerificationJob,
} from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeEscalationsMemory,
  makeNamespaceUsageMemory,
  makePlacedProject,
  makePlanStoreMemory,
  makeProjectsMemory,
  makeStagingWriterMemory,
  makeTrunkWriterMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { expect, vi } from "vitest";
import type { LaneDO } from "../../src/adapters/driving/do/lane.ts";
import type { TrunkDO } from "../../src/adapters/driving/do/trunk.ts";
import { ChangesRpc } from "../../src/adapters/driven/do-rpc/changes.ts";
import { backbone, type LaneServices } from "../../src/composition/do.ts";
import { decodeExit, LaneCodecs, TrunkCodecs } from "../../src/rpc/index.ts";
import { drainAfter } from "./helpers.ts";
import { placedIn } from "./pool-harness.ts";

const WAIT = { timeout: 10_000, interval: 20 };
/** The plan every change the harness queues was compiled under. */
export const PLAN_HASH = `sha256:${"0".repeat(64)}`;

const MAIN = "refs/heads/main";

/**
 * The project's real Lane DO, on in-memory driven adapters as the Lane DO's
 * own pool test runs it, reading its members from their real Change DOs.
 * Staging holds one commit, `base`, and its writer moves the code host's own
 * main, so the lane follows trunk in the same staging the Trunk reads.
 * KeelVerify is the in-memory verification, whose started jobs the test
 * answers through the lane's `recordVerdict`.
 */
export async function realLane(
  projectId: ProjectId,
  options: {
    /** Who the lane puts a question to: the project's maintainers in memory unless given. */
    readonly gate?: Layer.Layer<HumanGate>;
    /** Where the project is placed: in memory, in the sample namespace, unless given. */
    readonly places?: Layer.Layer<ProjectNamespaces>;
  } = {},
) {
  const stub = drainAfter(env.LANE.get(env.LANE.idFromName(laneOf(projectId))));
  const staging = projectRepos(projectId).staging;
  const code = makeCodeHostMemory();
  const run = <A>(program: Effect.Effect<A, unknown, CodeHost>) =>
    Effect.runPromise(program.pipe(Effect.provide(code.layer)));
  const base = await run(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(staging);
      return yield* code.fixture.commit(staging, MAIN, { "README.md": "keel\n" });
    }),
  );
  const stagingRefs = () => code.repos.get(`${staging.namespace}/${staging.name}`)?.refs;
  const verification = makeBatchVerificationMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(projectId, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: "private",
  });
  const changes = ChangesRpc({
    change: (id) => env.CHANGE.get(env.CHANGE.idFromName(`change:${id}`)),
    agentSession: (id) => env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${id}`)),
  });
  const driven: Layer.Layer<LaneServices> = Layer.mergeAll(
    options.gate ?? makeEscalationsMemory().gate,
    code.layer,
    makePlanStoreMemory().layer,
    changes,
    makeAgentDirectoryMemory().layer,
    makeCandidateComposerMemory().layer,
    makeCandidateBundlesMemory().layer,
    verification.layer,
    makeStagingWriterMemory({
      get: () => stagingRefs()?.get(MAIN),
      set: (to) => void stagingRefs()?.set(MAIN, to),
    }).layer,
    projects.layer,
    options.places ?? makePlacedProject(projectId).layer,
  );
  await runInDurableObject(stub, (instance: LaneDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
    );
  });

  /** KeelVerify's job for `batchId`, once the lane has started it. */
  const job = async (batchId: string | undefined) => {
    let found: readonly [string, VerificationJob] | undefined;
    await vi.waitFor(() => {
      found = [...verification.started.entries()].find(([, j]) => j.fence.batchId === batchId);
      expect(found).toBeDefined();
    }, WAIT);
    if (found === undefined) throw new Error(`KeelVerify never started for ${String(batchId)}`);
    return found;
  };

  /** Answers the batch's KeelVerify job with `outcome` and its remedy, as the workflow's last step does, with what it counted. */
  const verdict = async (
    batchId: string | undefined,
    outcome: "land" | "bounce",
    evidence: readonly string[],
    nextActions?: readonly NextAction[],
    tests?: readonly StepCount[],
  ) => {
    const [instanceId, started] = await job(batchId);
    const recordedId = makeId("vrd", ulid());
    const recorded = decodeExit(
      LaneCodecs.recordVerdict,
      await stub.recordVerdict({
        instanceId,
        fence: started.fence,
        candidateId: started.candidateId,
        verdictId: recordedId,
        outcome,
        planHash: PLAN_HASH,
        evidence: [...evidence],
        failingTests: outcome === "bounce" ? ["test/auth.test.ts"] : [],
        ...(nextActions === undefined ? {} : { nextActions: [...nextActions] }),
        ...(tests === undefined ? {} : { tests: [...tests] }),
      }),
    );
    expect(recorded).toEqual(Exit.void);
    return { ...started, verdictId: recordedId };
  };

  /**
   * The batch's candidate in staging, at refs/heads/cand/<candidateId> on
   * staging's main (`base` until a batch lands, trunk's head after, which the
   * lane moves staging to before it forms the next), where the Trunk reads the
   * commit it promotes. The memory composer names the ref without writing it,
   * so the test writes what the lane's push would have.
   */
  const candidate = (candidateId: string) => {
    const ref = `refs/heads/cand/${candidateId}`;
    stagingRefs()?.set(ref, stagingRefs()?.get(MAIN) ?? base);
    return run(
      code.fixture.commit(staging, ref, {
        "README.md": "keel\n",
        [`src/${candidateId}.ts`]: "export const landed = true;\n",
      }),
    );
  };

  return { stub, job, verdict, candidate, code, base };
}

/**
 * The project's real Trunk DO, promoting through the lane's
 * memory staging and a memory trunk writer at the lane's `base`, initialized
 * there. Everything else is the object's own: it hears the lane's
 * BatchVerified, subscribes the batch's members to its advance, and commits
 * TrunkAdvanced from its WAL, push and read-back.
 */
export async function realTrunk(projectId: ProjectId, lane: Awaited<ReturnType<typeof realLane>>) {
  const stub = drainAfter(env.TRUNK.get(env.TRUNK.idFromName(`trunk:${projectId}`)));
  const writer = makeTrunkWriterMemory(lane.base);
  await runInDurableObject(stub, (instance: TrunkDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          lane.code.layer,
          writer.layer,
          placedIn(projectId).layer,
          makeNamespaceUsageMemory().layer,
        ),
      ),
    );
  });
  expect(
    decodeExit(TrunkCodecs.initialize, await stub.initialize(lane.base, "seed", { kind: "empty" })),
  ).toEqual(Exit.succeed({ head: lane.base, promotion: "idle", origin: { kind: "empty" } }));
  /** Trunk's own events, read inside the object. */
  const log = () =>
    runInDurableObject(stub, (instance: TrunkDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "trunk", id: projectId })),
      ),
    );
  return { stub, writer, log };
}
