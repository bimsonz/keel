import { Effect, Result, Schema } from "effect";
import { Deployment, DeploymentPromoted, DeliveryRefused } from "../../domain/delivery/index.ts";
import { ProjectNotFound } from "../../domain/integration/index.ts";
import type {
  CandidateId,
  CommitSha,
  DeploymentId,
  EntityRef,
  ProjectId,
} from "../../domain/kernel/index.ts";
import { PROJECT } from "../integration/index.ts";
import {
  type Clock,
  commit,
  type DeliveryRefusal,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  type Stored,
  type Transaction,
} from "../ports/index.ts";

/**
 * Where the Project DO keeps its deployments, keyed by the candidate id: one
 * per candidate Keel previewed, as it now stands. The object is the project's
 * own, so the candidate alone names one.
 */
export const DEPLOYMENTS = "deployments";

/** The stage a promotion puts a version at: Keel promotes the previewed version to all of the Worker's traffic at once. */
export const PROMOTED_STAGE = "production";

type Store = Transaction["store"];

const decodeDeployment = Schema.decodeUnknownSync(Deployment);
const encodeDeployment = Schema.encodeSync(Deployment);
const encodePromoted = Schema.encodeSync(DeploymentPromoted);
const encodeRefused = Schema.encodeSync(DeliveryRefused);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

const created = (store: Store, projectId: ProjectId): boolean =>
  store.get(PROJECT, projectId) !== undefined;

const keptFor = (store: Store, candidateId: CandidateId): Deployment | undefined => {
  const value = store.get(DEPLOYMENTS, candidateId);
  return value === undefined ? undefined : decodeDeployment(value);
};

const keptAs = (store: Store, deploymentId: DeploymentId): Deployment | undefined =>
  store
    .list(DEPLOYMENTS)
    .map((row) => decodeDeployment(row.value))
    .find((deployment) => deployment.id === deploymentId);

const projectRef = (projectId: ProjectId): EntityRef => ({ kind: "project", id: projectId });

/** The deployment the project keeps for the candidate, or undefined; ProjectNotFound before the project is created. */
export const deploymentOf: (
  projectId: ProjectId,
  candidateId: CandidateId,
) => Effect.Effect<Deployment | undefined, ProjectNotFound, EntityStore> = Effect.fn(
  "delivery/deploymentOf",
)(function* (projectId: ProjectId, candidateId: CandidateId) {
  const store = yield* EntityStore;
  if (!created(store, projectId)) return yield* new ProjectNotFound({ projectId });
  return keptFor(store, candidateId);
});

/**
 * Keeps a candidate's deployment in its Project DO, in place of any kept for
 * it before: a candidate previewed again is kept as its latest preview. It
 * commits no event (each member change's PreviewDeployed tells of the
 * preview), so the outbox keeps nothing under its cause,
 * `preview:<deploymentId>`, to replay. A replay is the same deployment again,
 * and finds it kept: it leaves it as it stands, so a late retry never undoes
 * the deployment's promotion.
 */
export const recordDeployment: (
  projectId: ProjectId,
  deployment: Deployment,
) => Effect.Effect<void, ProjectNotFound, Clock | EntityStore | EventOutbox> = Effect.fn(
  "delivery/recordDeployment",
)(function* (projectId: ProjectId, deployment: Deployment) {
  yield* commit(
    { entity: projectRef(projectId), cause: `preview:${deployment.id}`, project: projectId },
    (
      tx,
    ): Result.Result<
      { readonly value: void; readonly drafts: readonly EventDraft[] },
      ProjectNotFound
    > => {
      if (!created(tx.store, projectId)) return Result.fail(new ProjectNotFound({ projectId }));
      if (keptFor(tx.store, deployment.candidateId)?.id !== deployment.id)
        tx.store.put(DEPLOYMENTS, deployment.candidateId, asStored(encodeDeployment(deployment)));
      return Result.succeed({ value: undefined, drafts: [] });
    },
  );
});

/**
 * Marks one of the project's deployments `promoted` to trunk's commit and
 * commits DeploymentPromoted on the project, once: the cause is
 * `promote:<deploymentId>:<trunkSha>`, so one already promoted to that commit
 * commits nothing, and a promotion redelivered after a later one never moves
 * the record back. A deployment the project does not hold commits nothing
 * either: the Deliver workflow promotes only one it read from this object, so
 * there is no record to mark and nothing to tell, and the caller is not
 * failed for it.
 */
export const promoteDeployment: (
  projectId: ProjectId,
  promotion: { readonly deploymentId: DeploymentId; readonly trunkSha: CommitSha },
) => Effect.Effect<void, ProjectNotFound, Clock | EntityStore | EventOutbox> = Effect.fn(
  "delivery/promoteDeployment",
)(function* (
  projectId: ProjectId,
  promotion: { readonly deploymentId: DeploymentId; readonly trunkSha: CommitSha },
) {
  const { deploymentId, trunkSha } = promotion;
  yield* commit(
    {
      entity: projectRef(projectId),
      cause: `promote:${deploymentId}:${trunkSha}`,
      project: projectId,
    },
    (
      tx,
    ): Result.Result<
      { readonly value: void; readonly drafts: readonly EventDraft[] },
      ProjectNotFound
    > => {
      if (!created(tx.store, projectId)) return Result.fail(new ProjectNotFound({ projectId }));
      const kept = keptAs(tx.store, deploymentId);
      if (kept === undefined) return Result.succeed({ value: undefined, drafts: [] });
      tx.store.put(
        DEPLOYMENTS,
        kept.candidateId,
        asStored(encodeDeployment({ ...kept, state: "promoted", promotedTo: trunkSha })),
      );
      const promoted = DeploymentPromoted.make({
        deploymentId,
        trunkSha,
        target: kept.target,
        provider: "cloudflare",
        stage: PROMOTED_STAGE,
      });
      return Result.succeed({
        value: undefined,
        drafts: [{ payload: payloadOf(encodePromoted(promoted)) }],
      });
    },
  );
});

/**
 * Commits DeliveryRefused on the project: trunk advanced to `trunkSha` and Keel
 * deployed nothing, for the reason given. The cause is
 * `delivery-refused:<trunkSha>`, so a redelivery of the same advance commits
 * it once.
 */
export const refuseDelivery: (
  projectId: ProjectId,
  refusal: DeliveryRefusal,
) => Effect.Effect<void, ProjectNotFound, Clock | EntityStore | EventOutbox> = Effect.fn(
  "delivery/refuseDelivery",
)(function* (projectId: ProjectId, refusal: DeliveryRefusal) {
  yield* commit(
    {
      entity: projectRef(projectId),
      cause: `delivery-refused:${refusal.trunkSha}`,
      project: projectId,
    },
    (
      tx,
    ): Result.Result<
      { readonly value: void; readonly drafts: readonly EventDraft[] },
      ProjectNotFound
    > => {
      if (!created(tx.store, projectId)) return Result.fail(new ProjectNotFound({ projectId }));
      const refused = DeliveryRefused.make({ projectId, ...refusal });
      return Result.succeed({
        value: undefined,
        drafts: [{ payload: payloadOf(encodeRefused(refused)) }],
      });
    },
  );
});
