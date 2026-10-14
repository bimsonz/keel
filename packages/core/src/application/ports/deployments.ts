import { Context, type Effect } from "effect";
import type { Deployment, DeliveryRefused } from "../../domain/delivery/index.ts";
import type { CandidateId, CommitSha, DeploymentId, ProjectId } from "../../domain/kernel/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";

/** Why trunk advanced and Keel deployed nothing, as `DeliveryRefused` says it. */
export type DeliveryRefusal = Omit<typeof DeliveryRefused.Type, "_tag" | "projectId">;

/**
 * A project's deployments, held by its Project DO (`project:<id>`): one per
 * candidate Keel previewed, and what became of each.
 *
 * - `record` keeps a candidate's preview, replacing any kept for it before.
 * - `of` reads the one kept for a candidate.
 * - `promoted` marks one deployed as trunk's commit and commits
 *   `DeploymentPromoted`, once: one already promoted to that commit commits
 *   nothing.
 * - `refused` commits `DeliveryRefused`.
 */
export class Deployments extends Context.Service<
  Deployments,
  {
    readonly record: (
      projectId: ProjectId,
      deployment: Deployment,
    ) => Effect.Effect<void, ProjectNotFound>;
    readonly of: (
      projectId: ProjectId,
      candidateId: CandidateId,
    ) => Effect.Effect<Deployment | undefined, ProjectNotFound>;
    readonly promoted: (
      projectId: ProjectId,
      promotion: { readonly deploymentId: DeploymentId; readonly trunkSha: CommitSha },
    ) => Effect.Effect<void, ProjectNotFound>;
    readonly refused: (
      projectId: ProjectId,
      refusal: DeliveryRefusal,
    ) => Effect.Effect<void, ProjectNotFound>;
  }
>()("keel/Deployments") {}
