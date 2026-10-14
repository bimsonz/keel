// A project's deployments as its Project DO keeps them: one per candidate,
// promoted once to trunk's commit, and each refusal to deliver committed once
// per trunk commit. The use-cases run over one object's in-memory store and
// outbox; the adapter's case crosses the object's own codecs.
import { describe, expect, it } from "@effect/vitest";
import {
  deploymentOf,
  promoteDeployment,
  recordDeployment,
  refuseDelivery,
} from "@keeltown/core/application/delivery";
import { PROJECT as PROJECT_RECORD, ProjectRecord } from "@keeltown/core/application/integration";
import { type Deployment, DeployTargetName } from "@keeltown/core/domain/delivery";
import {
  type CandidateId,
  CommitSha,
  type DeploymentId,
  Instant,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import {
  type Clock,
  type DeliveryRefusal,
  Deployments,
  type EntityStore,
  EventOutbox,
} from "@keeltown/core/ports";
import { makeEventOutboxMemory, makeManualClock } from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import {
  type DeploymentsStub,
  DeploymentsRpc,
} from "../../src/adapters/driven/do-rpc/deployments.ts";
import {
  DeliveryRefusedCommand,
  DeploymentOfCommand,
  DeploymentPromotedCommand,
  encodeExit,
  type ExitCodec,
  ProjectCodecs,
  RecordDeploymentCommand,
} from "../../src/rpc/index.ts";

const PROJECT: ProjectId = makeId("prj", "01M4P00000000000000000000P");
const CANDIDATE: CandidateId = makeId("cnd", "01M4P00000000000000000000C");
const OTHER_CANDIDATE: CandidateId = makeId("cnd", "01M4P00000000000000000000D");
const FIRST: DeploymentId = makeId("dpl", "01M4P00000000000000000000F");
const SECOND: DeploymentId = makeId("dpl", "01M4P00000000000000000000G");
const TRUNK = CommitSha.make("a".repeat(40));
const NEXT_TRUNK = CommitSha.make("b".repeat(40));
const target = Schema.decodeSync(DeployTargetName);

const deployment = (id: DeploymentId, candidateId = CANDIDATE): Deployment => ({
  id,
  target: target("preview"),
  worker: "worker-lite",
  candidateId,
  candidateCommit: TRUNK,
  changes: [makeId("chg", "01M4P00000000000000000000H")],
  versionId: `${id.slice(-8).toLowerCase()}-0000-4000-8000-000000000000`,
  url: `https://${id.slice(-8).toLowerCase()}-worker-lite.acme.workers.dev`,
  aliasUrl: "https://ch-000000000h-worker-lite.acme.workers.dev",
  state: "previewing",
  previewedAt: 1_000,
});

const refusal = (trunkSha = TRUNK): DeliveryRefusal => ({
  trunkSha,
  candidateId: CANDIDATE,
  reason: "commit-differs",
  detail: "trunk's new commit is not the candidate's own",
});

const encodeProjectRecord = Schema.encodeSync(ProjectRecord);

/** One Project DO's store and outbox, on a clock the test holds; `establish` writes the record createProject leaves. */
function projectObject() {
  const object = makeEventOutboxMemory();
  const layer = Layer.mergeAll(object.layer, makeManualClock().layer);
  const establish = () =>
    object.store.service.put(
      PROJECT_RECORD,
      PROJECT,
      JSON.parse(
        JSON.stringify(encodeProjectRecord({ id: PROJECT, name: "acme", createdAt: Instant(0) })),
      ),
    );
  return { object, layer, establish };
}

/** The project's events, as their payloads. */
const payloads = Effect.map(EventOutbox, (outbox) =>
  outbox.log({ kind: "project", id: PROJECT }).map((event) => event.payload),
);

const trunkShaOf = (payload: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ trunkSha: Schema.String }))(payload).trunkSha;

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.parse(JSON.stringify(Cause.squash(exit.cause))) : "succeeded";

describe("a project's deployments", () => {
  it.effect(
    "[deployments.record-of] a recorded deployment is what `of` answers for its candidate, and no other",
    () => {
      const { layer, establish } = projectObject();
      establish();
      return Effect.gen(function* () {
        expect(yield* deploymentOf(PROJECT, CANDIDATE)).toBeUndefined();
        yield* recordDeployment(PROJECT, deployment(FIRST));
        expect(yield* deploymentOf(PROJECT, CANDIDATE)).toEqual(deployment(FIRST));
        expect(yield* deploymentOf(PROJECT, OTHER_CANDIDATE)).toBeUndefined();
        expect(yield* payloads).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[deployments.record-replaces] a candidate previewed again is kept by its latest deployment",
    () => {
      const { layer, establish } = projectObject();
      establish();
      return Effect.gen(function* () {
        yield* recordDeployment(PROJECT, deployment(FIRST));
        yield* recordDeployment(PROJECT, deployment(SECOND));
        expect(yield* deploymentOf(PROJECT, CANDIDATE)).toEqual(deployment(SECOND));
        expect(yield* payloads).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[deployments.record-replay] the same deployment recorded again after its promotion leaves it promoted",
    () => {
      const { layer, establish } = projectObject();
      establish();
      return Effect.gen(function* () {
        yield* recordDeployment(PROJECT, deployment(FIRST));
        yield* promoteDeployment(PROJECT, { deploymentId: FIRST, trunkSha: TRUNK });
        yield* recordDeployment(PROJECT, deployment(FIRST));
        expect(yield* deploymentOf(PROJECT, CANDIDATE)).toEqual({
          ...deployment(FIRST),
          state: "promoted",
          promotedTo: TRUNK,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[deployments.promote-once] a promotion marks the deployment promoted to trunk's commit and commits DeploymentPromoted once, however often it is told",
    () => {
      const { layer, establish } = projectObject();
      establish();
      return Effect.gen(function* () {
        yield* recordDeployment(PROJECT, deployment(FIRST));
        yield* promoteDeployment(PROJECT, { deploymentId: FIRST, trunkSha: TRUNK });
        yield* promoteDeployment(PROJECT, { deploymentId: FIRST, trunkSha: TRUNK });
        expect(yield* deploymentOf(PROJECT, CANDIDATE)).toEqual({
          ...deployment(FIRST),
          state: "promoted",
          promotedTo: TRUNK,
        });
        expect(yield* payloads).toEqual([
          {
            _tag: "DeploymentPromoted",
            deploymentId: FIRST,
            trunkSha: TRUNK,
            target: "preview",
            provider: "cloudflare",
            stage: "production",
          },
        ]);
        // Trunk deployed as it at a later commit is a promotion of its own; the first, redelivered after it, moves nothing back.
        yield* promoteDeployment(PROJECT, { deploymentId: FIRST, trunkSha: NEXT_TRUNK });
        yield* promoteDeployment(PROJECT, { deploymentId: FIRST, trunkSha: TRUNK });
        expect((yield* payloads).map(trunkShaOf)).toEqual([TRUNK, NEXT_TRUNK]);
        expect((yield* deploymentOf(PROJECT, CANDIDATE))?.promotedTo).toBe(NEXT_TRUNK);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[deployments.promote-unheld] a deployment the project does not hold is promoted to nothing: no record, no event, no failure",
    () => {
      const { layer, establish } = projectObject();
      establish();
      return Effect.gen(function* () {
        yield* recordDeployment(PROJECT, deployment(FIRST));
        const promoted = yield* Effect.exit(
          promoteDeployment(PROJECT, { deploymentId: SECOND, trunkSha: TRUNK }),
        );
        expect(failureOf(promoted)).toBe("succeeded");
        expect(yield* deploymentOf(PROJECT, CANDIDATE)).toEqual(deployment(FIRST));
        expect(yield* payloads).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[deployments.refuse-once] a refusal commits DeliveryRefused once per trunk commit",
    () => {
      const { layer, establish } = projectObject();
      establish();
      return Effect.gen(function* () {
        yield* refuseDelivery(PROJECT, refusal());
        yield* refuseDelivery(PROJECT, refusal());
        yield* refuseDelivery(PROJECT, refusal(NEXT_TRUNK));
        expect(yield* payloads).toEqual([
          { _tag: "DeliveryRefused", projectId: PROJECT, ...refusal() },
          { _tag: "DeliveryRefused", projectId: PROJECT, ...refusal(NEXT_TRUNK) },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[deployments.project-not-found] before the project is created every call is ProjectNotFound, and nothing is kept or committed",
    () => {
      const { layer } = projectObject();
      return Effect.gen(function* () {
        const exits = [
          yield* Effect.exit(recordDeployment(PROJECT, deployment(FIRST))),
          yield* Effect.exit(deploymentOf(PROJECT, CANDIDATE)),
          yield* Effect.exit(promoteDeployment(PROJECT, { deploymentId: FIRST, trunkSha: TRUNK })),
          yield* Effect.exit(refuseDelivery(PROJECT, refusal())),
        ];
        expect(exits.map(failureOf)).toEqual(
          exits.map(() => ({ _tag: "ProjectNotFound", projectId: PROJECT })),
        );
        expect(yield* payloads).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});

/** A Project DO's four methods as the object answers them: the command decoded, the use-case run, the Exit encoded. */
function stubOver(layer: ReturnType<typeof projectObject>["layer"]) {
  const answer = <A, E>(
    codec: ExitCodec<A, E>,
    program: Effect.Effect<A, E, Clock | EntityStore | EventOutbox>,
  ) =>
    Effect.runPromiseExit(program.pipe(Effect.provide(layer))).then((exit) =>
      encodeExit(codec, exit),
    );
  const stub: DeploymentsStub = {
    recordDeployment: (command) =>
      answer(
        ProjectCodecs.recordDeployment,
        Effect.flatMap(
          Effect.orDie(Schema.decodeUnknownEffect(RecordDeploymentCommand)(command)),
          (recording) => recordDeployment(recording.projectId, recording.deployment),
        ),
      ),
    deploymentOf: (command) =>
      answer(
        ProjectCodecs.deploymentOf,
        Effect.flatMap(
          Effect.orDie(Schema.decodeUnknownEffect(DeploymentOfCommand)(command)),
          (reading) => deploymentOf(reading.projectId, reading.candidateId),
        ),
      ),
    deploymentPromoted: (command) =>
      answer(
        ProjectCodecs.deploymentPromoted,
        Effect.flatMap(
          Effect.orDie(Schema.decodeUnknownEffect(DeploymentPromotedCommand)(command)),
          ({ projectId, ...promotion }) => promoteDeployment(projectId, promotion),
        ),
      ),
    deliveryRefused: (command) =>
      answer(
        ProjectCodecs.deliveryRefused,
        Effect.flatMap(
          Effect.orDie(Schema.decodeUnknownEffect(DeliveryRefusedCommand)(command)),
          ({ projectId, ...refused }) => refuseDelivery(projectId, refused),
        ),
      ),
  };
  return stub;
}

describe("DeploymentsRpc", () => {
  it.effect(
    "[deployments.rpc] the port over the object's methods keeps, reads, promotes and refuses as the use-cases do, every field crossing",
    () => {
      const { layer, establish } = projectObject();
      establish();
      const addressed: ProjectId[] = [];
      const port = DeploymentsRpc((projectId) => {
        addressed.push(projectId);
        return stubOver(layer);
      });
      return Effect.gen(function* () {
        const deployments = yield* Deployments;
        expect(yield* deployments.of(PROJECT, CANDIDATE)).toBeUndefined();
        yield* deployments.record(PROJECT, deployment(FIRST));
        expect(yield* deployments.of(PROJECT, CANDIDATE)).toEqual(deployment(FIRST));
        yield* deployments.promoted(PROJECT, { deploymentId: FIRST, trunkSha: TRUNK });
        yield* deployments.refused(PROJECT, refusal(NEXT_TRUNK));
        expect(yield* deployments.of(PROJECT, CANDIDATE)).toEqual({
          ...deployment(FIRST),
          state: "promoted",
          promotedTo: TRUNK,
        });
        expect(yield* payloads.pipe(Effect.provide(layer))).toEqual([
          {
            _tag: "DeploymentPromoted",
            deploymentId: FIRST,
            trunkSha: TRUNK,
            target: "preview",
            provider: "cloudflare",
            stage: "production",
          },
          { _tag: "DeliveryRefused", projectId: PROJECT, ...refusal(NEXT_TRUNK) },
        ]);
        expect(new Set(addressed)).toEqual(new Set([PROJECT]));
      }).pipe(Effect.provide(port));
    },
  );

  it.effect(
    "[deployments.rpc-not-found] a project not yet created crosses as ProjectNotFound",
    () => {
      const { layer } = projectObject();
      const port = DeploymentsRpc(() => stubOver(layer));
      return Effect.gen(function* () {
        const read = yield* Effect.exit((yield* Deployments).of(PROJECT, CANDIDATE));
        expect(failureOf(read)).toEqual({ _tag: "ProjectNotFound", projectId: PROJECT });
      }).pipe(Effect.provide(port));
    },
  );
});
