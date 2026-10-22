// The project's real Lane and Trunk DOs in workerd, on in-memory driven
// adapters, reading their members from the changes' real Change DOs: the
// harness the pool cases share where a change moves through its lane. Every
// move trunk makes is git's too, in the lane's memory code host, so what reads
// a trunk's repo (a proposal from a fork, a fork's sync) reads what it holds.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { laneOf } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import type { TrunkOrigin } from "@keeltown/core/domain/integration";
import type { StepCount } from "@keeltown/core/domain/verification";
import { CommitSha, makeId, type NextAction, type ProjectId } from "@keeltown/core/kernel";
import {
  CodeHost,
  EventOutbox,
  type HumanGate,
  MergeRefused,
  type ProjectNamespaces,
  type RepoRef,
  TrunkWriter,
  type VerificationJob,
} from "@keeltown/core/ports";
import {
  decodeCommit,
  decodeTree,
  hashObject,
  mergeOnBase,
  MissingObject,
  Refusal,
} from "@keeltown/gitcore";
import {
  makeAgentDirectoryMemory,
  makeNamespacesMemory,
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
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { expect, vi } from "vitest";
import type { LaneDO } from "../../src/adapters/driving/do/lane.ts";
import type { TrunkDO } from "../../src/adapters/driving/do/trunk.ts";
import { ChangesRpc } from "../../src/adapters/driven/do-rpc/changes.ts";
import { TrunksRpc } from "../../src/adapters/driven/do-rpc/trunks.ts";
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
 * answers through the lane's `recordVerdict`. Lanes given one `code` share
 * it, as projects share Artifacts; one given a `composer` composes with it.
 */
export async function realLane(
  projectId: ProjectId,
  options: {
    /** Who the lane puts a question to: the project's maintainers in memory unless given. */
    readonly gate?: Layer.Layer<HumanGate>;
    /** Where the project is placed: in memory, in the sample namespace, unless given. */
    readonly places?: Layer.Layer<ProjectNamespaces>;
    /** The code host the lane, its trunk and staging are in: one of their own unless given. */
    readonly code?: ReturnType<typeof makeCodeHostMemory>;
    readonly composer?: ReturnType<typeof makeCandidateComposerMemory>;
  } = {},
) {
  const stub = drainAfter(env.LANE.get(env.LANE.idFromName(laneOf(projectId))));
  const repos = projectRepos(projectId);
  const { staging } = repos;
  const code = options.code ?? makeCodeHostMemory();
  const composer = options.composer ?? makeCandidateComposerMemory();
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
    makeNamespacesMemory().layer,
    composer.layer,
    makeCandidateBundlesMemory().layer,
    verification.layer,
    makeStagingWriterMemory({
      get: () => stagingRefs()?.get(MAIN),
      // Staging follows trunk as a relay from it would: what trunk holds and staging lacks (a fork's merge) comes along.
      set: (to) => {
        const trunk = code.repos.get(`${repos.trunk.namespace}/${repos.trunk.name}`);
        const into = code.repos.get(`${staging.namespace}/${staging.name}`);
        for (const [oid, object] of trunk?.objects ?? []) into?.objects.set(oid, object);
        into?.refs.set(MAIN, to);
      },
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
   * so the test writes what the lane's push would have: a file of its own, or
   * the whole tree `files` gives, under a message of its own.
   */
  const candidate = (candidateId: string, files?: Readonly<Record<string, string>>) => {
    const ref = `refs/heads/cand/${candidateId}`;
    stagingRefs()?.set(ref, stagingRefs()?.get(MAIN) ?? base);
    return run(
      files === undefined
        ? code.fixture.commit(staging, ref, {
            "README.md": "keel\n",
            [`src/${candidateId}.ts`]: "export const landed = true;\n",
          })
        : code.fixture.commit(staging, ref, files, [], `Land ${candidateId}`),
    );
  };

  return { stub, job, verdict, candidate, code, base, composer };
}

/** The memory host's repo, which the lane made or the trunk made beside it. */
const held = (code: ReturnType<typeof makeCodeHostMemory>, repo: RepoRef) => {
  const found = code.repos.get(`${repo.namespace}/${repo.name}`);
  if (found === undefined) throw new Error(`${repo.name} is not in the memory code host`);
  return found;
};

/** Every object of `from` in `to` as well: what a relay between two repos leaves. */
const copied = (code: ReturnType<typeof makeCodeHostMemory>, from: RepoRef, to: RepoRef) => {
  const target = held(code, to);
  for (const [oid, object] of held(code, from).objects) target.objects.set(oid, object);
  return target;
};

/** The one author and committer of the merges a test's trunk makes. */
const KEEL = { name: "Keel", email: "keel@keel.test", time: 1_760_000_000 };

/**
 * A memory trunk writer whose moves are git's in `code` as well: a push
 * copies the candidate from staging into trunk's repo and moves its main; a
 * sync puts trunk's main into each repo it is given that the host holds; a
 * fork's fetch copies its upstream's trunk in; whether one commit descends
 * from another is the trunk repo's own history; and a fork's merge is
 * gitcore's, written into trunk's repo. The head, its fence and what was
 * pushed stay the memory writer's.
 */
const gitBacked = (
  code: ReturnType<typeof makeCodeHostMemory>,
  projectId: ProjectId,
  writer: ReturnType<typeof makeTrunkWriterMemory>,
): Layer.Layer<TrunkWriter> => {
  const { trunk, staging } = projectRepos(projectId);
  const moveMain = (to: CommitSha) => held(code, trunk).refs.set(MAIN, to);
  return Layer.effect(
    TrunkWriter,
    Effect.map(TrunkWriter, (memory) =>
      TrunkWriter.of({
        ...memory,
        push: (from, to, admit) =>
          Effect.tap(memory.push(from, to, admit), () =>
            Effect.sync(() => {
              copied(code, staging, trunk);
              if (writer.head() === to) moveMain(to);
            }),
          ),
        fastForward: (from, to) =>
          Effect.tap(memory.fastForward(from, to), () => Effect.sync(() => moveMain(to))),
        sync: (repos) =>
          Effect.tap(memory.sync(repos), ({ head }) =>
            Effect.sync(() => {
              for (const repo of repos)
                if (code.repos.has(`${repo.namespace}/${repo.name}`))
                  copied(code, trunk, repo).refs.set(MAIN, head);
            }),
          ),
        fetchProject: (source) =>
          Effect.sync(() => {
            copied(code, source, trunk);
            return 32;
          }),
        descends: (from, to, stopAt) =>
          Effect.orDie(
            Effect.flatMap(CodeHost, (host) => host.isAncestor(trunk, from, to, stopAt)).pipe(
              Effect.provide(code.layer),
            ),
          ),
        mergeUpstream: ({ ours, theirs, base, message }) =>
          Effect.tryPromise({
            try: async () => {
              const objects = held(code, trunk).objects;
              const read = (oid: string, type: string) => {
                const object = objects.get(oid);
                if (object?.type !== type) throw new MissingObject(oid);
                return object.body;
              };
              const merged = await mergeOnBase(
                {
                  readTree: async (oid) => decodeTree(read(oid, "tree")),
                  readBlob: async (oid) => read(oid, "blob"),
                  readCommit: async (oid) => decodeCommit(read(oid, "commit")),
                },
                { base, ours, theirs, author: KEEL, committer: KEEL, message },
              );
              const oids = await Promise.all(
                merged.objects.map((object) => hashObject(object.type, object.body)),
              );
              merged.objects.forEach((object, at) => objects.set(oids[at] ?? "", object));
              return { commit: Schema.decodeUnknownSync(CommitSha)(merged.oid), bytes: 32 };
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              cause instanceof Refusal
                ? Effect.fail(new MergeRefused({ path: cause.path, reason: cause.reason }))
                : Effect.die(cause),
            ),
          ),
      }),
    ),
  ).pipe(Layer.provide(writer.layer));
};

/**
 * The project's real Trunk DO, promoting through the lane's memory staging
 * and a memory trunk writer at the lane's `base`, initialized there with
 * `origin` (empty unless given), its repo in the lane's code host holding
 * what staging does. Everything else is the object's own: it hears the
 * lane's BatchVerified, subscribes the batch's members to its advance,
 * commits TrunkAdvanced from its WAL, push and read-back, and a fork's sync
 * asks its upstream's Trunk DO for that trunk's head.
 */
export async function realTrunk(
  projectId: ProjectId,
  lane: Awaited<ReturnType<typeof realLane>>,
  origin: TrunkOrigin = { kind: "empty" },
) {
  const stub = drainAfter(env.TRUNK.get(env.TRUNK.idFromName(`trunk:${projectId}`)));
  const writer = makeTrunkWriterMemory(lane.base);
  const { trunk, staging } = projectRepos(projectId);
  await Effect.runPromise(
    Effect.flatMap(CodeHost, (host) => host.create(trunk)).pipe(Effect.provide(lane.code.layer)),
  );
  copied(lane.code, staging, trunk).refs.set(MAIN, lane.base);
  await runInDurableObject(stub, (instance: TrunkDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          lane.code.layer,
          gitBacked(lane.code, projectId, writer),
          placedIn(projectId).layer,
          makeNamespaceUsageMemory().layer,
          TrunksRpc(env.TRUNK),
        ),
      ),
    );
  });
  expect(
    decodeExit(
      TrunkCodecs.initialize,
      await stub.initialize(lane.base, origin.kind === "forked" ? "fork" : "seed", origin),
    ),
  ).toEqual(Exit.succeed({ head: lane.base, promotion: "idle", origin }));
  /** Trunk's own events, read inside the object. */
  const log = () =>
    runInDurableObject(stub, (instance: TrunkDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "trunk", id: projectId })),
      ),
    );
  return { stub, writer, log };
}
