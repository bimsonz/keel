import { Context, type Effect } from "effect";
import type {
  ConnectStateRefused,
  DeployTarget,
  DeployTargetName,
  DeployTargetRefused,
  PendingConnect,
} from "../../domain/delivery/index.ts";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import type { ProjectId, UserId } from "../../domain/kernel/index.ts";

/**
 * A project's deploy target as its Project DO holds it: the record, and the
 * workers.dev subdomain its account answered when it was last set. The
 * subdomain is the provider's answer, kept beside the record and never in it.
 */
export interface HeldDeployTarget {
  readonly target: DeployTarget;
  readonly workersDev?: string | undefined;
}

/**
 * Set a project's deploy target. `credentialInOrg` is whether the credential
 * is one of the project's own namespace, read by the caller before anything
 * else; `workersDev` is what the account answered, asked only once it is.
 * `requestId` keys the commit, as it keys a settings PUT.
 */
export interface SetProjectDeployTarget {
  readonly projectId: ProjectId;
  readonly target: DeployTarget;
  readonly by: UserId;
  readonly credentialInOrg: boolean;
  readonly workersDev?: string | undefined;
  readonly requestId: string;
}

export interface ClearProjectDeployTarget {
  readonly projectId: ProjectId;
  readonly name: DeployTargetName;
  readonly by: UserId;
  readonly requestId: string;
}

/**
 * A Connect an owner begins on a project: held under them, one at a time,
 * until their callback takes it or its window closes. The project's object
 * stamps when it lapses, by its own clock.
 */
export interface HoldProjectConnect {
  readonly projectId: ProjectId;
  readonly by: UserId;
  readonly target: DeployTargetName;
  readonly nonce: string;
  readonly verifier: string;
}

/** A callback's claim on the Connect its owner began on the project, by the nonce its state carried. */
export interface TakeProjectConnect {
  readonly projectId: ProjectId;
  readonly by: UserId;
  readonly nonce: string;
}

/**
 * The way to a project's deploy targets, held by its Project DO
 * (`project:<id>`): the DO decides each set and clear with the delivery
 * domain over the targets it holds, and commits `DeployTargetSet` or
 * `DeployTargetCleared`. A refusal commits nothing. `list` is in name order.
 * It also holds the Connects its owners have begun and not finished.
 */
export class DeployTargets extends Context.Service<
  DeployTargets,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly HeldDeployTarget[], ProjectNotFound>;
    readonly set: (
      command: SetProjectDeployTarget,
    ) => Effect.Effect<
      HeldDeployTarget,
      DeployTargetRefused | ProjectNotFound | IdempotencyConflict
    >;
    readonly clear: (
      command: ClearProjectDeployTarget,
    ) => Effect.Effect<void, DeployTargetRefused | ProjectNotFound>;
    /** Holds a begun Connect for its owner, in place of any they began before on the project. */
    readonly holdConnect: (command: HoldProjectConnect) => Effect.Effect<void, ProjectNotFound>;
    /**
     * The Connect the owner began, if the nonce is its own and its window is
     * open. Whatever it answers, the owner's pending Connect is gone after it.
     */
    readonly takeConnect: (
      command: TakeProjectConnect,
    ) => Effect.Effect<PendingConnect, ProjectNotFound | ConnectStateRefused>;
  }
>()("keel/DeployTargets") {}
