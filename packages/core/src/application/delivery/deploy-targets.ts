import { Effect, Result, Schema } from "effect";
import {
  clearDeployTarget,
  DeployTarget,
  DeployTargetCleared,
  type DeployTargetRefused,
  DeployTargetSet,
  type DeployTargetUnreachable,
  evolveDeployTargets,
  setDeployTarget,
} from "../../domain/delivery/index.ts";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { ProjectNotFound } from "../../domain/integration/index.ts";
import {
  contentHashOf,
  type EntityRef,
  type Json,
  type NamespaceId,
  type ProjectId,
  userActor,
  type UserId,
} from "../../domain/kernel/index.ts";
import { PROJECT } from "../integration/index.ts";
import {
  type ClearProjectDeployTarget,
  type Clock,
  commit,
  CredentialStore,
  DeployTargetCheck,
  DeployTargets,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  type HeldDeployTarget,
  type SetProjectDeployTarget,
  type Stored,
  type Transaction,
} from "../ports/index.ts";

/**
 * Where the Project DO keeps its deploy targets, keyed by the project id: the
 * records as `evolveDeployTargets` folds the project's events, and beside them
 * what each target's account answered when it was set. Absent until the first set.
 */
export const DEPLOY_TARGETS = "deploy-targets";

const Held = Schema.Struct({
  targets: Schema.Array(DeployTarget),
  /** The workers.dev subdomain each target's account answered, by target name. */
  workersDev: Schema.Record(Schema.String, Schema.String),
});
type Held = typeof Held.Type;

const NONE: Held = { targets: [], workersDev: {} };

type Store = Transaction["store"];

const decodeHeld = Schema.decodeUnknownSync(Held);
const encodeHeld = Schema.encodeSync(Held);
const encodeSet = Schema.encodeSync(DeployTargetSet);
const encodeCleared = Schema.encodeSync(DeployTargetCleared);
const encodeTarget = Schema.encodeSync(DeployTarget);
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

const created = (store: Store, projectId: ProjectId): boolean =>
  store.get(PROJECT, projectId) !== undefined;

const heldIn = (store: Store, projectId: ProjectId): Held => {
  const value = store.get(DEPLOY_TARGETS, projectId);
  return value === undefined ? NONE : decodeHeld(value);
};

const viewOf = (held: Held, target: DeployTarget): HeldDeployTarget => {
  const workersDev = held.workersDev[target.name];
  return workersDev === undefined ? { target } : { target, workersDev };
};

const projectRef = (projectId: ProjectId): EntityRef => ({ kind: "project", id: projectId });

/** The project's deploy targets in name order; ProjectNotFound before the project is created. */
export const deployTargetsOf: (
  projectId: ProjectId,
) => Effect.Effect<readonly HeldDeployTarget[], ProjectNotFound, EntityStore> = Effect.fn(
  "delivery/deployTargetsOf",
)(function* (projectId: ProjectId) {
  const store = yield* EntityStore;
  if (!created(store, projectId)) return yield* new ProjectNotFound({ projectId });
  const held = heldIn(store, projectId);
  return held.targets.map((target) => viewOf(held, target));
});

/**
 * Sets one of the project's deploy targets in its Project DO, decided by
 * `setDeployTarget` over the targets the object holds, and commits
 * `DeployTargetSet` under the owner who set it. The account's workers.dev
 * subdomain is kept beside the record, so a target set again to what it was
 * commits nothing and still keeps the latest answer. The cause is
 * `deploy-target:<requestId>`: a replay answers what the first call did, and
 * the same request id with another target is IdempotencyConflict.
 */
export const commitDeployTarget: (
  command: SetProjectDeployTarget,
) => Effect.Effect<
  HeldDeployTarget,
  ProjectNotFound | DeployTargetRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox
> = Effect.fn("delivery/commitDeployTarget")(function* (command: SetProjectDeployTarget) {
  const { projectId, target, by, credentialInOrg, workersDev, requestId } = command;
  const answer: HeldDeployTarget = workersDev === undefined ? { target } : { target, workersDev };
  const fingerprint = contentHashOf(
    asJson({ target: encodeTarget(target), by, credentialInOrg, workersDev: workersDev ?? null }),
  );
  const committed = yield* commit(
    {
      entity: projectRef(projectId),
      cause: `deploy-target:${requestId}`,
      fingerprint,
      actor: userActor(by),
      project: projectId,
    },
    (
      tx,
    ): Result.Result<
      { readonly value: HeldDeployTarget; readonly drafts: readonly EventDraft[] },
      ProjectNotFound | DeployTargetRefused
    > => {
      if (!created(tx.store, projectId)) return Result.fail(new ProjectNotFound({ projectId }));
      const held = heldIn(tx.store, projectId);
      const decided = setDeployTarget(held.targets, { projectId, target, by, credentialInOrg });
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      const targets = decided.success.reduce(
        (folded, event) => evolveDeployTargets(folded, event),
        held.targets,
      );
      const { [target.name]: _before, ...others } = held.workersDev;
      const answered = workersDev === undefined ? others : { ...others, [target.name]: workersDev };
      tx.store.put(
        DEPLOY_TARGETS,
        projectId,
        asStored(encodeHeld({ targets, workersDev: answered })),
      );
      return Result.succeed({
        value: answer,
        drafts: decided.success.map((event) => ({ payload: payloadOf(encodeSet(event)) })),
      });
    },
  );
  if (!committed.duplicate) return committed.value;
  if (!committed.sameCommand) return yield* new IdempotencyConflict({ idempotencyKey: requestId });
  return answer;
});

/**
 * Clears one of the project's deploy targets in its Project DO, decided by
 * `clearDeployTarget` (refused `not-set` when it holds none of that name), and
 * commits `DeployTargetCleared`. The cause is
 * `deploy-target-clear:<name>:<requestId>`, so a replay of the request finds
 * the target cleared by it and answers as the first did.
 */
export const commitDeployTargetClear: (
  command: ClearProjectDeployTarget,
) => Effect.Effect<void, ProjectNotFound | DeployTargetRefused, Clock | EntityStore | EventOutbox> =
  Effect.fn("delivery/commitDeployTargetClear")(function* (command: ClearProjectDeployTarget) {
    const { projectId, name, by, requestId } = command;
    yield* commit(
      {
        entity: projectRef(projectId),
        cause: `deploy-target-clear:${name}:${requestId}`,
        actor: userActor(by),
        project: projectId,
      },
      (
        tx,
      ): Result.Result<
        { readonly value: void; readonly drafts: readonly EventDraft[] },
        ProjectNotFound | DeployTargetRefused
      > => {
        if (!created(tx.store, projectId)) return Result.fail(new ProjectNotFound({ projectId }));
        const held = heldIn(tx.store, projectId);
        const decided = clearDeployTarget(held.targets, { projectId, name, by });
        if (Result.isFailure(decided)) return Result.fail(decided.failure);
        const targets = decided.success.reduce(
          (folded, event) => evolveDeployTargets(folded, event),
          held.targets,
        );
        const { [name]: _cleared, ...workersDev } = held.workersDev;
        tx.store.put(DEPLOY_TARGETS, projectId, asStored(encodeHeld({ targets, workersDev })));
        return Result.succeed({
          value: undefined,
          drafts: decided.success.map((event) => ({ payload: payloadOf(encodeCleared(event)) })),
        });
      },
    );
  });

/** A deploy target an owner puts, on a project of `namespaceId`. */
export interface PutDeployTarget {
  readonly projectId: ProjectId;
  /** The project's own namespace: the one store its target's credential may come from. */
  readonly namespaceId: NamespaceId;
  readonly target: DeployTarget;
  readonly by: UserId;
  readonly requestId: string;
}

/**
 * Sets a project's deploy target. Whether the credential is one of
 * the project's own namespace is read first, and a credential that is not is
 * refused by `setDeployTarget` before its secret is opened or any provider is
 * asked. One that is must reach the account's Workers before anything is
 * committed: the secret is opened only to ask, and DeployTargetUnreachable
 * commits nothing. A credential removed between the two reads is not in the
 * namespace any more, and is refused the same way.
 */
export const putDeployTarget: (
  input: PutDeployTarget,
) => Effect.Effect<
  HeldDeployTarget,
  DeployTargetRefused | DeployTargetUnreachable | ProjectNotFound | IdempotencyConflict,
  CredentialStore | DeployTargetCheck | DeployTargets
> = Effect.fn("delivery/putDeployTarget")(function* (input: PutDeployTarget) {
  const { projectId, namespaceId, target, by, requestId } = input;
  const credentials = yield* CredentialStore;
  const inOrg = yield* credentials.has(namespaceId, target.credential);
  const secret = inOrg
    ? yield* credentials
        .reveal(namespaceId, target.credential)
        .pipe(Effect.catchTag("CredentialMissing", () => Effect.succeed(undefined)))
    : undefined;
  const reach =
    secret === undefined
      ? undefined
      : yield* DeployTargetCheck.use((check) => check.reach(target.accountId, secret));
  return yield* DeployTargets.use((targets) =>
    targets.set({
      projectId,
      target,
      by,
      credentialInOrg: secret !== undefined,
      workersDev: reach?.workersDev,
      requestId,
    }),
  );
});

/** A project's deploy targets, as its Project DO holds them, in name order. */
export const listDeployTargets: (
  projectId: ProjectId,
) => Effect.Effect<readonly HeldDeployTarget[], ProjectNotFound, DeployTargets> = (projectId) =>
  DeployTargets.use((targets) => targets.list(projectId));

/** Clears a project's deploy target; one the project has none of by that name is refused `not-set`. */
export const removeDeployTarget: (
  command: ClearProjectDeployTarget,
) => Effect.Effect<void, DeployTargetRefused | ProjectNotFound, DeployTargets> = (command) =>
  DeployTargets.use((targets) => targets.clear(command));
