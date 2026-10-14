import { Effect, Option, Result, Schedule } from "effect";
import type { CandidateId, CommitSha, DeploymentId, ProjectId } from "../../domain/kernel/index.ts";
import {
  CredentialStore,
  Deployer,
  Deployments,
  type DeliveryRefusal,
  DeployTargets,
  ProjectNamespaces,
} from "../ports/index.ts";

/** A trunk advance as Deliver reads it: the project, trunk's new commit, and the candidates that landed, in group order. */
export interface TrunkDelivery {
  readonly projectId: ProjectId;
  readonly to: CommitSha;
  readonly candidates: readonly CandidateId[];
}

/** What Deliver did for one trunk advance. The token is never in it. */
export type Delivered =
  | { readonly _tag: "Promoted"; readonly deploymentId: DeploymentId }
  | { readonly _tag: "AlreadyPromoted"; readonly deploymentId: DeploymentId }
  | { readonly _tag: "Refused"; readonly reason: DeliveryRefusal["reason"] }
  | { readonly _tag: "Nothing"; readonly why: string };

/** What Deliver asks: the project's records and targets, its namespace's credentials, and the provider. */
export type DeliverServices =
  | CredentialStore
  | Deployer
  | Deployments
  | DeployTargets
  | ProjectNamespaces;

/** How often a promote the provider could not be reached for is asked again, and how far apart. */
const UNREACHABLE_RETRIES = 2;
const UNREACHABLE_SPACING = "2 seconds";

/**
 * Deploys trunk after a landing (ADR 0008): the version Keel previewed for
 * the landed candidate is promoted to all of its Worker's traffic on the
 * target's account, and the project commits `DeploymentPromoted`.
 *
 * It promotes only when trunk's new commit is the candidate's own commit, the
 * one whose build was previewed. That is right at L1, where a group is one
 * batch and trunk is pushed to the candidate's tip. A group that composes new
 * commits moves trunk to a commit no preview was built from, so it is
 * refused `commit-differs` and nothing is deployed: fail-safe, never a deploy
 * of a tree nobody previewed.
 *
 * A deployment already promoted to this commit is a no-op that commits
 * nothing, so a redelivered advance deploys once. With no preview of the
 * landed candidate, a project with a deploy target commits `DeliveryRefused`
 * (`no-preview`), and one with none is left alone. The token is revealed only
 * for the provider's call, and never put in a record, an event or the answer.
 */
export const deliverTrunk = (
  advance: TrunkDelivery,
): Effect.Effect<Delivered, never, DeliverServices> =>
  Effect.gen(function* () {
    const { projectId, to } = advance;
    const deployments = yield* Deployments;
    const candidateId = advance.candidates.at(-1);
    const refuse = (refusal: Omit<DeliveryRefusal, "trunkSha" | "candidateId">) =>
      deployments
        .refused(projectId, {
          trunkSha: to,
          ...(candidateId === undefined ? {} : { candidateId }),
          ...refusal,
        })
        .pipe(
          Effect.catchTag("ProjectNotFound", () => Effect.void),
          Effect.as<Delivered>({ _tag: "Refused", reason: refusal.reason }),
        );
    const held = yield* (yield* DeployTargets)
      .list(projectId)
      .pipe(Effect.catchTag("ProjectNotFound", () => Effect.succeed(undefined)));
    if (held === undefined) return { _tag: "Nothing", why: "the project's object is gone" };
    const deployment =
      candidateId === undefined
        ? undefined
        : yield* deployments
            .of(projectId, candidateId)
            .pipe(Effect.catchTag("ProjectNotFound", () => Effect.succeed(undefined)));
    if (deployment === undefined)
      return held.length === 0
        ? { _tag: "Nothing", why: "the project has no deploy target" }
        : yield* refuse({
            reason: "no-preview",
            detail: `no preview was made of ${candidateId ?? "the landed candidate"}, so nothing is deployed`,
          });
    if (deployment.promotedTo === to)
      return { _tag: "AlreadyPromoted", deploymentId: deployment.id };
    if (deployment.candidateCommit !== to)
      return yield* refuse({
        reason: "commit-differs",
        detail:
          deployment.candidateCommit === undefined
            ? `the preview of ${deployment.candidateId} names no commit, so it is not known to be trunk's ${to}`
            : `trunk moved to ${to}, not to ${deployment.candidateCommit}, the commit ${deployment.candidateId}'s preview was built from`,
      });
    const found = held.find((h) => h.target.name === deployment.target);
    if (found === undefined || found.workersDev === undefined)
      return yield* refuse({
        reason: "promote-failed",
        detail: `the deploy target ${deployment.target} is no longer connected`,
      });
    const place = yield* (yield* ProjectNamespaces).byId(projectId);
    if (Option.isNone(place))
      return yield* refuse({ reason: "promote-failed", detail: "the project has no namespace" });
    const token = yield* (yield* CredentialStore)
      .reveal(place.value.namespace, found.target.credential)
      .pipe(Effect.catchTag("CredentialMissing", () => Effect.succeed(undefined)));
    if (token === undefined)
      return yield* refuse({
        reason: "promote-failed",
        detail: `the deploy target ${deployment.target}'s credential is gone: an owner connects the account again`,
      });
    const promoted = yield* (yield* Deployer)
      .promote({ accountId: found.target.accountId, workersDev: found.workersDev }, token, {
        worker: deployment.worker,
        versionId: deployment.versionId,
        message: `keel: trunk ${to}`,
      })
      .pipe(
        Effect.retry({
          while: (failed) => failed.reason === "unreachable",
          schedule: Schedule.spaced(UNREACHABLE_SPACING),
          times: UNREACHABLE_RETRIES,
        }),
        Effect.result,
      );
    if (Result.isFailure(promoted))
      return yield* refuse({
        reason: "promote-failed",
        detail: `the promote was not taken: ${promoted.failure.detail}`,
      });
    yield* deployments
      .promoted(projectId, { deploymentId: deployment.id, trunkSha: to })
      .pipe(Effect.catchTag("ProjectNotFound", () => Effect.void));
    return { _tag: "Promoted", deploymentId: deployment.id };
  });
