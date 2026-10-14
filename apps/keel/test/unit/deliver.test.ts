import { describe, expect, it } from "@effect/vitest";
import { deliverTrunk, type TrunkDelivery } from "@keeltown/core/application/delivery";
import { type Deployment, DeploymentFailed, DeployTarget } from "@keeltown/core/domain/delivery";
import { CommitSha, type CredentialId, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CredentialStore, Deployer, DeployTargets } from "@keeltown/core/ports";
import {
  freshId,
  makeDeployerMemory,
  makeDeploymentsMemory,
  makeProjectNamespacesMemory,
  sampleNamespace,
} from "@keeltown/testing";
import { Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";

const TOKEN = "cf-token-SECRET-only-in-a-header";
const PROJECT: ProjectId = freshId("prj");
const CREDENTIAL: CredentialId = makeId("crd", "0".repeat(25) + "1");
const TARGET = Schema.decodeUnknownSync(DeployTarget)({
  name: "production",
  provider: "cloudflare",
  accountId: "0123456789abcdef0123456789abcdef",
  credential: CREDENTIAL,
});
const CANDIDATE = freshId("cnd");
const COMMIT = CommitSha.make("c".repeat(40));
const OTHER = CommitSha.make("d".repeat(40));
const DEPLOYMENT: Deployment = {
  id: makeId("dpl", "0".repeat(25) + "1"),
  target: TARGET.name,
  worker: "worker-lite",
  candidateId: CANDIDATE,
  candidateCommit: COMMIT,
  changes: [freshId("chg")],
  versionId: "00000001-0000-4000-8000-000000000000",
  url: "https://00000001-worker-lite.owner.workers.dev",
  state: "previewing",
  previewedAt: 1,
};
const ADVANCE: TrunkDelivery = { projectId: PROJECT, to: COMMIT, candidates: [CANDIDATE] };

/** Every port Deliver asks, in memory: the targets, the deployments held, and a Deployer that may be swapped. */
const world = (
  options: {
    readonly targets?: readonly DeployTarget[];
    readonly held?: readonly Deployment[];
    readonly deployer?: Layer.Layer<Deployer>;
  } = {},
) => {
  const deployer = makeDeployerMemory();
  const deployments = makeDeploymentsMemory();
  for (const deployment of options.held ?? [DEPLOYMENT])
    deployments.held.set(`${PROJECT}/${deployment.candidateId}`, deployment);
  const namespaces = makeProjectNamespacesMemory();
  namespaces.places.set(PROJECT, {
    projectId: PROJECT,
    namespace: sampleNamespace,
    name: "worker-lite",
  });
  const revealed: CredentialId[] = [];
  const targets = Layer.succeed(
    DeployTargets,
    DeployTargets.of({
      list: () =>
        Effect.succeed(
          (options.targets ?? [TARGET]).map((target) => ({
            target,
            workersDev: "owner.workers.dev",
          })),
        ),
      set: () => Effect.die("not asked"),
      clear: () => Effect.die("not asked"),
    }),
  );
  const credentials = Layer.succeed(
    CredentialStore,
    CredentialStore.of({
      put: () => Effect.die("not asked"),
      list: () => Effect.die("not asked"),
      has: () => Effect.die("not asked"),
      remove: () => Effect.die("not asked"),
      reveal: (_namespace, id) =>
        Effect.sync(() => {
          revealed.push(id);
          return Redacted.make(TOKEN);
        }),
    }),
  );
  const layer = Layer.mergeAll(
    options.deployer ?? deployer.layer,
    deployments.layer,
    namespaces.layer,
    targets,
    credentials,
  );
  return { deployer, deployments, revealed, layer };
};

const failingPromote = (reasons: readonly DeploymentFailed["reason"][]) => {
  const asked: string[] = [];
  const layer = Layer.succeed(
    Deployer,
    Deployer.of({
      preview: () => Effect.die("not asked"),
      promote: (_account, _token, deploy) =>
        Effect.suspend(() => {
          const reason = reasons[asked.length];
          asked.push(deploy.versionId);
          return reason === undefined
            ? Effect.succeed({ deploymentId: "dep-1" })
            : Effect.fail(
                new DeploymentFailed({
                  operation: "promote",
                  reason,
                  detail: `Cloudflare said ${reason}`,
                }),
              );
        }),
      deleteVersion: () => Effect.die("not asked"),
    }),
  );
  return { asked, layer };
};

describe("Deliver", () => {
  it.effect(
    "[deliver.promotes-candidate-commit] trunk at the candidate's own commit promotes its previewed version on the target's account and commits DeploymentPromoted",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const delivered = yield* deliverTrunk(ADVANCE);
        expect(delivered).toEqual({ _tag: "Promoted", deploymentId: DEPLOYMENT.id });
        expect(w.deployer.calls).toEqual([
          {
            op: "promote",
            account: { accountId: TARGET.accountId, workersDev: "owner.workers.dev" },
            deploy: {
              worker: "worker-lite",
              versionId: DEPLOYMENT.versionId,
              message: `keel: trunk ${COMMIT}`,
            },
          },
        ]);
        expect(w.revealed).toEqual([CREDENTIAL]);
        expect(w.deployments.committed).toEqual([
          {
            type: "DeploymentPromoted",
            projectId: PROJECT,
            deploymentId: DEPLOYMENT.id,
            trunkSha: COMMIT,
          },
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deliver.once] a trunk advance delivered again promotes nothing more and commits nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* deliverTrunk(ADVANCE);
        const again = yield* deliverTrunk(ADVANCE);
        expect(again).toEqual({ _tag: "AlreadyPromoted", deploymentId: DEPLOYMENT.id });
        expect(w.deployer.calls).toHaveLength(1);
        expect(w.revealed).toHaveLength(1);
        expect(w.deployments.committed).toHaveLength(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deliver.commit-differs] trunk at another commit than the preview's, or a preview naming none, is refused commit-differs: no token opened, no call",
    () =>
      Effect.gen(function* () {
        for (const held of [DEPLOYMENT, { ...DEPLOYMENT, candidateCommit: undefined }]) {
          const { candidateCommit: _, ...rest } = held;
          const deployment: Deployment =
            held.candidateCommit === undefined ? rest : { ...rest, candidateCommit: OTHER };
          const w = world({ held: [deployment] });
          const delivered = yield* deliverTrunk(ADVANCE).pipe(Effect.provide(w.layer));
          expect(delivered).toEqual({ _tag: "Refused", reason: "commit-differs" });
          expect(w.deployer.calls).toEqual([]);
          expect(w.revealed).toEqual([]);
          expect(w.deployments.committed).toEqual([
            {
              type: "DeliveryRefused",
              projectId: PROJECT,
              refusal: {
                trunkSha: COMMIT,
                candidateId: CANDIDATE,
                reason: "commit-differs",
                detail: expect.stringContaining(String(CANDIDATE)),
              },
            },
          ]);
        }
      }),
  );

  it.effect(
    "[deliver.no-preview] with no preview of the landed candidate, a project with a deploy target is refused no-preview, and one with none is left alone",
    () =>
      Effect.gen(function* () {
        const connected = world({ held: [] });
        const refused = yield* deliverTrunk(ADVANCE).pipe(Effect.provide(connected.layer));
        expect(refused).toEqual({ _tag: "Refused", reason: "no-preview" });
        expect(connected.deployments.committed.map((c) => c.type)).toEqual(["DeliveryRefused"]);
        expect(connected.deployer.calls).toEqual([]);

        const unconnected = world({ held: [], targets: [] });
        const nothing = yield* deliverTrunk(ADVANCE).pipe(Effect.provide(unconnected.layer));
        expect(nothing._tag).toBe("Nothing");
        expect(unconnected.deployments.committed).toEqual([]);
        expect(unconnected.deployer.calls).toEqual([]);
      }),
  );

  it.effect(
    "[deliver.promote-failed] a promote Cloudflare refuses, or a target no longer connected, is refused promote-failed naming why, and nothing is promoted",
    () =>
      Effect.gen(function* () {
        const refusing = failingPromote(["refused"]);
        const w = world({ deployer: refusing.layer });
        const delivered = yield* deliverTrunk(ADVANCE).pipe(Effect.provide(w.layer));
        expect(delivered).toEqual({ _tag: "Refused", reason: "promote-failed" });
        expect(refusing.asked).toHaveLength(1);
        const [refusal] = w.deployments.committed;
        expect(refusal).toMatchObject({
          type: "DeliveryRefused",
          refusal: { reason: "promote-failed", detail: expect.stringContaining("refused") },
        });

        const staging = Schema.decodeUnknownSync(DeployTarget)({
          ...Schema.encodeSync(DeployTarget)(TARGET),
          name: "staging",
        });
        const gone = world({ targets: [staging] });
        const unconnected = yield* deliverTrunk(ADVANCE).pipe(Effect.provide(gone.layer));
        expect(unconnected).toEqual({ _tag: "Refused", reason: "promote-failed" });
        expect(gone.deployer.calls).toEqual([]);
        expect(gone.revealed).toEqual([]);
      }),
  );

  it.effect(
    "[deliver.unreachable-retried] a promote Cloudflare could not be reached for is asked twice more, two seconds apart, before it is refused",
    () =>
      Effect.gen(function* () {
        const flaky = failingPromote(["unreachable", "unreachable"]);
        const w = world({ deployer: flaky.layer });
        const fiber = yield* Effect.forkChild(deliverTrunk(ADVANCE).pipe(Effect.provide(w.layer)));
        yield* TestClock.adjust("4 seconds");
        expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Promoted", deploymentId: DEPLOYMENT.id });
        expect(flaky.asked).toHaveLength(3);

        const down = failingPromote(["unreachable", "unreachable", "unreachable", "unreachable"]);
        const v = world({ deployer: down.layer });
        const failed = yield* Effect.forkChild(deliverTrunk(ADVANCE).pipe(Effect.provide(v.layer)));
        yield* TestClock.adjust("4 seconds");
        expect(yield* Fiber.join(failed)).toEqual({ _tag: "Refused", reason: "promote-failed" });
        expect(down.asked).toHaveLength(3);
      }),
  );

  it.effect(
    "[deliver.token-nowhere] the token is in no answer and no record Deliver commits",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const delivered = yield* deliverTrunk(ADVANCE);
        const refusedWorld = world({ deployer: failingPromote(["refused"]).layer });
        const refused = yield* deliverTrunk(ADVANCE).pipe(Effect.provide(refusedWorld.layer));
        const seen = JSON.stringify([
          delivered,
          refused,
          w.deployments.committed,
          [...w.deployments.held.values()],
          refusedWorld.deployments.committed,
        ]);
        expect(w.revealed).toHaveLength(1);
        expect(seen).not.toContain(TOKEN);
      }).pipe(Effect.provide(w.layer));
    },
  );
});
