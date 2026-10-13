import {
  commitDeployTarget,
  commitDeployTargetClear,
  deployTargetsOf,
} from "@keeltown/core/application/delivery";
import { PROJECT, ProjectRecord } from "@keeltown/core/application/integration";
import {
  type CredentialMeta,
  CredentialMissing,
  type DeployTargetUnreachable,
} from "@keeltown/core/domain/delivery";
import {
  type CredentialId,
  Instant,
  makeId,
  type NamespaceId,
  type ProjectId,
} from "@keeltown/core/kernel";
import {
  CredentialStore,
  Deployer,
  type DeployPlan,
  DeployTargetCheck,
  DeployTargets,
  type TargetReach,
} from "@keeltown/core/ports";
import { Clock, Effect, Layer, Redacted, Result, Schema } from "effect";
import { makeEventOutboxMemory } from "./event-outbox.ts";
import { makeClockMemory } from "./identity.ts";

/** Every lifecycle step succeeds and is recorded, so tests can assert the order. */
export function makeDeployerMemory() {
  const steps: { readonly operation: string; readonly plan: DeployPlan }[] = [];
  let counter = 0;
  const step =
    (operation: "preview" | "verify" | "promote" | "rollback" | "teardown") => (plan: DeployPlan) =>
      Effect.sync(() => {
        steps.push({ operation, plan });
        return {
          deploymentId: plan.deploymentId,
          operation,
          ok: true,
          detail: `${operation} recorded in memory`,
        };
      });
  return {
    steps,
    layer: Layer.succeed(
      Deployer,
      Deployer.of({
        plan: (target, bundle, world) =>
          Effect.sync(() => {
            counter += 1;
            return {
              deploymentId: makeId("dpl", counter.toString().padStart(26, "0")),
              target,
              bundle,
              world,
            };
          }),
        preview: step("preview"),
        verify: step("verify"),
        promote: (plan) => step("promote")(plan),
        rollback: step("rollback"),
        teardown: step("teardown"),
      }),
    ),
  };
}

/**
 * An org's credentials in a Map per namespace. The secret is kept as a
 * `Redacted` (it prints as `<redacted>`) and only `reveal` hands it out; every
 * other answer is the record alone, so a test that reads `list` sees what any
 * caller of the real store sees. Ids count up from one; time is Effect's clock.
 */
export function makeCredentialStoreMemory() {
  const held = new Map<
    NamespaceId,
    Map<CredentialId, { readonly meta: CredentialMeta; readonly secret: Redacted.Redacted }>
  >();
  const of = (namespaceId: NamespaceId) => {
    const kept = held.get(namespaceId) ?? new Map();
    held.set(namespaceId, kept);
    return kept;
  };
  let counter = 0;
  return {
    held,
    layer: Layer.succeed(
      CredentialStore,
      CredentialStore.of({
        put: (namespaceId, { label, provider, secret, by }) =>
          Effect.map(Clock.currentTimeMillis, (createdAt) => {
            counter += 1;
            const id = makeId("crd", counter.toString().padStart(26, "0"));
            const meta = { id, namespaceId, label, provider, createdAt, createdBy: by };
            of(namespaceId).set(id, { meta, secret: Redacted.make(Redacted.value(secret)) });
            return meta;
          }),
        list: (namespaceId) =>
          Effect.sync(() => [...of(namespaceId).values()].map((kept) => kept.meta)),
        has: (namespaceId, id) => Effect.sync(() => of(namespaceId).has(id)),
        reveal: (namespaceId, id) =>
          Effect.suspend(() => {
            const kept = of(namespaceId).get(id);
            return kept === undefined
              ? Effect.fail(new CredentialMissing({ id }))
              : Effect.succeed(kept.secret);
          }),
        remove: (namespaceId, id) =>
          Effect.suspend(() =>
            of(namespaceId).delete(id) ? Effect.void : Effect.fail(new CredentialMissing({ id })),
          ),
      }),
    ),
  };
}

const encodeProjectRecord = Schema.encodeSync(ProjectRecord);

/**
 * `DeployTargets` as the Project DO answers it: each project's own in-memory
 * store and outbox, under the object's own use-cases, so a set or a clear is
 * decided and committed as the object commits it. `establish` writes a
 * project's record as createProject leaves it; `outbox` is what a project's
 * object committed.
 */
export function makeDeployTargetsMemory() {
  const clock = makeClockMemory().layer;
  const objects = new Map<ProjectId, ReturnType<typeof makeEventOutboxMemory>>();
  const objectOf = (projectId: ProjectId) => {
    const found = objects.get(projectId) ?? makeEventOutboxMemory();
    objects.set(projectId, found);
    return found;
  };
  const inObject = (projectId: ProjectId) => Layer.mergeAll(objectOf(projectId).layer, clock);
  return {
    establish: (projectId: ProjectId) => {
      const record = { id: projectId, name: "memory-project", createdAt: Instant(0) };
      objectOf(projectId).store.service.put(
        PROJECT,
        projectId,
        JSON.parse(JSON.stringify(encodeProjectRecord(record))),
      );
    },
    outbox: (projectId: ProjectId) => objectOf(projectId).service,
    layer: Layer.succeed(
      DeployTargets,
      DeployTargets.of({
        list: (projectId) => deployTargetsOf(projectId).pipe(Effect.provide(inObject(projectId))),
        set: (command) =>
          commitDeployTarget(command).pipe(Effect.provide(inObject(command.projectId))),
        clear: (command) =>
          commitDeployTargetClear(command).pipe(Effect.provide(inObject(command.projectId))),
      }),
    ),
  };
}

/**
 * A `DeployTargetCheck` that answers what `answer` says of an account (a
 * workers.dev subdomain by default), and records each account it was asked
 * about with the secret it was asked with.
 */
export function makeDeployTargetCheckMemory(
  answer: (accountId: string) => Result.Result<TargetReach, DeployTargetUnreachable> = () =>
    Result.succeed({ workersDev: "memory.workers.dev" }),
) {
  const asked: { readonly accountId: string; readonly secret: string }[] = [];
  return {
    asked,
    layer: Layer.succeed(
      DeployTargetCheck,
      DeployTargetCheck.of({
        reach: (accountId, secret) =>
          Effect.suspend(() => {
            asked.push({ accountId, secret: Redacted.value(secret) });
            return Effect.fromResult(answer(accountId));
          }),
      }),
    ),
  };
}

/** The delivery ports an isolate's runtime provides, in memory, for a test that composes one. */
export const deliveryMemoryLayer = () =>
  Layer.mergeAll(
    makeCredentialStoreMemory().layer,
    makeDeployTargetCheckMemory().layer,
    makeDeployTargetsMemory().layer,
  );
