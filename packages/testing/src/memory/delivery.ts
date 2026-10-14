import {
  commitDeployTarget,
  commitDeployTargetClear,
  deployTargetsOf,
  holdConnect,
  takeConnect,
} from "@keeltown/core/application/delivery";
import { PROJECT, ProjectRecord } from "@keeltown/core/application/integration";
import {
  CloudflareConnectFailed,
  type CredentialMeta,
  CredentialMissing,
  type Deployment,
  type SmokeAnswer,
  type DeployTargetUnreachable,
  type GrantedAccount,
} from "@keeltown/core/domain/delivery";
import {
  type ChangeId,
  type CommitSha,
  type CredentialId,
  type DeploymentId,
  Instant,
  makeId,
  type NamespaceId,
  type ProjectId,
} from "@keeltown/core/kernel";
import {
  CloudflareOAuth,
  CredentialStore,
  type DeliveryRefusal,
  type DeployAccount,
  Deployer,
  Deployments,
  DeployTargetCheck,
  DeployTargets,
  type PreviewNotice,
  PreviewNotices,
  SmokeProbe,
  type TargetReach,
  type WorkerUpload,
} from "@keeltown/core/ports";
import { Clock, Effect, Layer, Redacted, Result, Schema } from "effect";
import { makeEventOutboxMemory } from "./event-outbox.ts";
import { makeClockMemory } from "./identity.ts";

/** A call the memory Deployer was asked, with what it was handed but the token. */
export type DeployerCall =
  | { readonly op: "preview"; readonly account: DeployAccount; readonly upload: WorkerUpload }
  | {
      readonly op: "promote";
      readonly account: DeployAccount;
      readonly deploy: {
        readonly worker: string;
        readonly versionId: string;
        readonly message: string;
      };
    }
  | {
      readonly op: "delete-version";
      readonly account: DeployAccount;
      readonly version: { readonly worker: string; readonly versionId: string };
    };

/**
 * A provider whose every call succeeds, as Cloudflare answers for a Worker
 * that starts: each is recorded (never its token), so tests can assert what
 * was sent and in what order. Version ids count up from one; their addresses
 * are formed as Cloudflare forms them.
 */
export function makeDeployerMemory() {
  const calls: DeployerCall[] = [];
  let counter = 0;
  return {
    calls,
    layer: Layer.succeed(
      Deployer,
      Deployer.of({
        preview: (account, _token, upload) =>
          Effect.sync(() => {
            counter += 1;
            calls.push({ op: "preview", account, upload });
            const versionId = `${counter.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
            return {
              versionId,
              url: `https://${versionId.slice(0, 8)}-${upload.worker}.${account.workersDev}`,
              ...(upload.alias === undefined
                ? {}
                : { aliasUrl: `https://${upload.alias}-${upload.worker}.${account.workersDev}` }),
            };
          }),
        promote: (account, _token, deploy) =>
          Effect.sync(() => {
            calls.push({ op: "promote", account, deploy });
            return { deploymentId: `deployment-of-${deploy.versionId}` };
          }),
        deleteVersion: (account, _token, version) =>
          Effect.sync(() => {
            calls.push({ op: "delete-version", account, version });
          }),
      }),
    ),
  };
}

/** What the memory Deployments committed, as the real object would commit it on the project's stream. */
export type DeploymentsCommitted =
  | {
      readonly type: "DeploymentPromoted";
      readonly projectId: ProjectId;
      readonly deploymentId: DeploymentId;
      readonly trunkSha: CommitSha;
    }
  | {
      readonly type: "DeliveryRefused";
      readonly projectId: ProjectId;
      readonly refusal: DeliveryRefusal;
    };

const deploymentKey = (projectId: ProjectId, candidateId: string) => `${projectId}/${candidateId}`;

/**
 * A project's deployments in a Map by project and candidate, and the events
 * the real object would commit, in order. A deployment promoted again to the
 * same commit commits nothing, as the real one.
 */
export function makeDeploymentsMemory() {
  const held = new Map<string, Deployment>();
  const committed: DeploymentsCommitted[] = [];
  return {
    held,
    committed,
    layer: Layer.succeed(
      Deployments,
      Deployments.of({
        record: (projectId, deployment) =>
          Effect.sync(() => {
            held.set(deploymentKey(projectId, deployment.candidateId), deployment);
          }),
        of: (projectId, candidateId) =>
          Effect.sync(() => held.get(deploymentKey(projectId, candidateId))),
        promoted: (projectId, { deploymentId, trunkSha }) =>
          Effect.sync(() => {
            const found = [...held.entries()].find(
              ([k, d]) => k.startsWith(`${projectId}/`) && d.id === deploymentId,
            );
            if (found === undefined) return;
            const [k, deployment] = found;
            if (deployment.state === "promoted" && deployment.promotedTo === trunkSha) return;
            held.set(k, { ...deployment, state: "promoted", promotedTo: trunkSha });
            committed.push({ type: "DeploymentPromoted", projectId, deploymentId, trunkSha });
          }),
        refused: (projectId, refusal) =>
          Effect.sync(() => {
            committed.push({ type: "DeliveryRefused", projectId, refusal });
          }),
      }),
    ),
  };
}

/** Each change told where its preview answers, in order. */
export function makePreviewNoticesMemory() {
  const told: { readonly changeId: ChangeId; readonly notice: PreviewNotice }[] = [];
  return {
    told,
    layer: Layer.succeed(
      PreviewNotices,
      PreviewNotices.of({
        tell: (changeId, notice) =>
          Effect.sync(() => {
            told.push({ changeId, notice });
          }),
      }),
    ),
  };
}

/**
 * A preview that answers each smoke request as `answer` says (by default 200
 * with `ok`), recording every address asked, in order.
 */
export function makeSmokeProbeMemory(
  answer: (url: string, asked: number) => SmokeAnswer = () => ({
    _tag: "answered",
    status: 200,
    body: "ok",
  }),
) {
  const asked: string[] = [];
  return {
    asked,
    layer: Layer.succeed(
      SmokeProbe,
      SmokeProbe.of({
        ask: (url) =>
          Effect.sync(() => {
            asked.push(url);
            return answer(url, asked.filter((u) => u === url).length);
          }),
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
        holdConnect: (command) =>
          holdConnect(command).pipe(Effect.provide(inObject(command.projectId))),
        takeConnect: (command) =>
          takeConnect(command).pipe(Effect.provide(inObject(command.projectId))),
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

/** What Cloudflare's OAuth answers, as `makeCloudflareOAuthMemory` plays it: each step may fail. */
export interface CloudflareOAuthScript {
  /** The accounts the consent granted: one by default. */
  readonly accounts?: readonly GrantedAccount[];
  /** The step Cloudflare refuses, if any. */
  readonly refuses?: CloudflareConnectFailed["step"];
}

/**
 * Cloudflare's OAuth in memory: a consent URL whose state is the project and
 * a nonce, an exchange that takes only the code `code-<verifier>` (as a code
 * is bound to its PKCE verifier), and a mint that answers a token naming the
 * account and the name. It records every exchange and mint, with the access
 * token each was asked with.
 */
export function makeCloudflareOAuthMemory(script: CloudflareOAuthScript = {}) {
  let made = 0;
  const exchanged: { readonly code: string; readonly verifier: string }[] = [];
  const minted: { readonly access: string; readonly accountId: string; readonly name: string }[] =
    [];
  const fails = (
    step: CloudflareConnectFailed["step"],
  ): Effect.Effect<void, CloudflareConnectFailed> =>
    script.refuses === step
      ? Effect.fail(new CloudflareConnectFailed({ step, status: 403 }))
      : Effect.void;
  return {
    exchanged,
    minted,
    layer: Layer.succeed(
      CloudflareOAuth,
      CloudflareOAuth.of({
        begin: (projectId) =>
          fails("unconfigured").pipe(
            Effect.map(() => {
              made += 1;
              const nonce = `n${String(made).padStart(42, "0")}`;
              const verifier = `verifier-${made}`;
              return { url: `https://consent.test/?state=${projectId}.${nonce}`, nonce, verifier };
            }),
          ),
        exchange: (code, verifier) =>
          Effect.suspend(() => {
            exchanged.push({ code, verifier });
            return code === `code-${verifier}`
              ? fails("exchange").pipe(Effect.as(Redacted.make(`access-${verifier}`)))
              : Effect.fail(new CloudflareConnectFailed({ step: "exchange", status: 400 }));
          }),
        accounts: () =>
          fails("accounts").pipe(
            Effect.as(
              script.accounts ?? [{ id: "0123456789abcdef0123456789abcdef", name: "Acme" }],
            ),
          ),
        mint: (access, accountId, name) =>
          Effect.suspend(() => {
            minted.push({ access: Redacted.value(access), accountId, name });
            return fails("mint").pipe(
              Effect.as(Redacted.make(`minted-${accountId}-${minted.length}`)),
            );
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
    makeCloudflareOAuthMemory().layer,
  );
