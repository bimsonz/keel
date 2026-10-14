import {
  beginCloudflareConnect,
  type CloudflareConnectError,
  completeCloudflareConnect,
  listDeployTargets,
  putDeployTarget,
  removeDeployTarget,
} from "@keeltown/core/application/delivery";
import {
  type CloudflareConnectFailed,
  CredentialLabel,
  type CredentialMeta,
  DeployTarget,
  DeployTargetName,
  type DeployTargetRefused,
  type DeployTargetUnreachable,
  readConnectState,
} from "@keeltown/core/domain/delivery";
import type { IdempotencyConflict } from "@keeltown/core/domain/identity";
import type { ProjectNotFound } from "@keeltown/core/domain/integration";
import { CredentialId, type NamespaceId, type ProjectId, type UserId } from "@keeltown/core/kernel";
import {
  CredentialStore,
  DeployTargets,
  type HeldDeployTarget,
  Namespaces,
  ProjectNamespaces,
} from "@keeltown/core/ports";
import { Effect, Option, Redacted, Result, Schema, SchemaIssue } from "effect";
import type {
  Delivery_beginCloudflareConnectResult,
  Delivery_completeCloudflareConnectResult,
  Delivery_createCredentialResult,
  Delivery_deleteDeployTargetResult,
  Delivery_listCredentialsResult,
  Delivery_listDeployTargetsResult,
  Delivery_putDeployTargetResult,
  Operations,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem, type ProblemBody } from "./problems.ts";
import type { Runner } from "./run.ts";

/**
 * A namespace's credentials and a project's deploy targets, an
 * owner's alone as the policy decides. A credential's secret goes in once,
 * as a Redacted, and nothing here answers it: no body, no problem detail.
 * Mappers are pure and each error union is mapped exhaustively.
 */

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];
type Issues = NonNullable<ProblemBody["issues"]>;

type CredentialBody = Extract<Delivery_createCredentialResult, { readonly status: 201 }>["body"];
type TargetBody = Extract<Delivery_putDeployTargetResult, { readonly status: 200 }>["body"];

const iso = (ms: number) => new Date(ms).toISOString();
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** The request's fields as the domain types them, or the issues a 400 names. */
function decodeWith<S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
): Result.Result<S["Type"], Issues> {
  return Result.mapError(Schema.decodeUnknownResult(schema)(value), (error) =>
    formatIssues(error.issue).issues.map((issue) => ({
      path: [
        "body",
        ...(issue.path ?? []).map((segment) => {
          const key = typeof segment === "object" ? segment.key : segment;
          return typeof key === "number" ? key : String(key);
        }),
      ],
      message: issue.message,
    })),
  );
}

const invalid = (caller: Caller, issues: Issues) => ({
  status: 400 as const,
  body: problem(400, "request.invalid", caller.requestId, { issues }),
});

const notFound = (caller: Caller, detail?: string) => ({
  status: 404 as const,
  body: problem(
    404,
    "resource.not_found",
    caller.requestId,
    detail === undefined ? {} : { detail },
  ),
});

const decodeCredentialId = Schema.decodeUnknownOption(CredentialId);
const decodeTargetName = Schema.decodeUnknownOption(DeployTargetName);

/** A credential as its owners read it: never the secret, which no record holds. */
export const credentialView = (meta: CredentialMeta): CredentialBody => ({
  id: meta.id,
  label: meta.label,
  provider: meta.provider,
  createdAt: iso(meta.createdAt),
  createdBy: meta.createdBy,
});

/** A deploy target, with the workers.dev subdomain its account answered when it was set. */
export const targetView = (held: HeldDeployTarget): TargetBody => ({
  name: held.target.name,
  provider: held.target.provider,
  accountId: held.target.accountId,
  credential: held.target.credential,
  ...(held.workersDev === undefined ? {} : { workersDev: held.workersDev }),
});

const LIST_CREDENTIALS = {
  kind: "read" as const,
  title: "Read the namespace's credentials",
  operationId: "Delivery_listCredentials",
};
const CONNECT_AGAIN = {
  kind: "call" as const,
  title: "Connect the account again through Cloudflare, which makes Keel a new token",
  operationId: "Delivery_beginCloudflareConnect",
};
const LIST_TARGETS = {
  kind: "read" as const,
  title: "Read the project's deploy targets",
  operationId: "Delivery_listDeployTargets",
};

/** A deploy target refused by the domain: 409 for a credential of another namespace or a full project, 404 for none set. */
function refused(caller: Caller, error: DeployTargetRefused) {
  switch (error.reason) {
    case "credential-not-in-org":
      return {
        status: 409 as const,
        body: problem(409, "deploy_target.refused", caller.requestId, {
          detail: `Deploy target ${error.name} names a credential this project's namespace does not hold. A target uses only a credential of its own project's namespace.`,
          nextActions: [LIST_CREDENTIALS, CONNECT_AGAIN],
        }),
      };
    case "too-many-targets":
      return {
        status: 409 as const,
        body: problem(409, "deploy_target.refused", caller.requestId, {
          detail: `The project already has all the deploy targets it may, so ${error.name} was not set. Clear one first, or set one already there again.`,
          nextActions: [LIST_TARGETS],
        }),
      };
    case "not-set":
      return notFound(caller, `The project has no deploy target named ${error.name}.`);
    default: {
      const unmapped: never = error.reason;
      return unmapped;
    }
  }
}

/** Cloudflare's own error code, when it gave one, for the detail. */
const codeOf = (error: DeployTargetUnreachable) =>
  error.code === undefined ? "" : ` (Cloudflare error ${error.code})`;

/** A credential that does not reach the account's Workers: 422, saying what to fix. */
function unreachable(caller: Caller, error: DeployTargetUnreachable) {
  switch (error.reason) {
    case "token-invalid":
      return {
        status: 422 as const,
        body: problem(422, "deploy_target.unreachable", caller.requestId, {
          detail: `Cloudflare refused the credential's token${codeOf(error)}: it is invalid, expired or revoked. Nothing was set.`,
          nextActions: [CONNECT_AGAIN],
        }),
      };
    case "account-unreachable":
      return {
        status: 422 as const,
        body: problem(422, "deploy_target.unreachable", caller.requestId, {
          detail: `The credential's token does not reach the account's Workers${codeOf(error)}: check the account id, and that the token may edit Workers on that account. Nothing was set.`,
          nextActions: [CONNECT_AGAIN],
        }),
      };
    case "no-workers-dev":
      return {
        status: 422 as const,
        body: problem(422, "deploy_target.no_workers_dev", caller.requestId, {
          detail: `The account has no workers.dev subdomain to serve previews from${codeOf(error)}. Keel never makes one: set a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages → your subdomain), then set the target again. Nothing was set.`,
          nextActions: [
            {
              kind: "call",
              title: "Set the target again once the account has a workers.dev subdomain",
              operationId: "Delivery_putDeployTarget",
            },
          ],
        }),
      };
    default: {
      const unmapped: never = error.reason;
      return unmapped;
    }
  }
}

const idempotencyConflict = (caller: Caller, error: IdempotencyConflict) => ({
  status: 409 as const,
  body: problem(409, "request.idempotency_conflict", caller.requestId, {
    detail: `Request id ${error.idempotencyKey} was already used for another change to this project's deploy targets.`,
    nextActions: [
      { kind: "call" as const, title: "Send the request again with a fresh request id" },
    ],
  }),
});

export function putTargetError(
  caller: Caller,
  error: DeployTargetRefused | DeployTargetUnreachable | ProjectNotFound | IdempotencyConflict,
): Exclude<Delivery_putDeployTargetResult, { readonly status: 200 }> {
  switch (error._tag) {
    case "DeployTargetRefused":
      return refused(caller, error);
    case "DeployTargetUnreachable":
      return unreachable(caller, error);
    case "ProjectNotFound":
      return notFound(caller);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error);
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function clearTargetError(
  caller: Caller,
  error: DeployTargetRefused | ProjectNotFound,
): Exclude<Delivery_deleteDeployTargetResult, { readonly status: 204 }> {
  switch (error._tag) {
    case "DeployTargetRefused":
      // `clearDeployTarget` refuses only a name the project has no target by.
      return notFound(caller, `The project has no deploy target named ${error.name}.`);
    case "ProjectNotFound":
      return notFound(caller);
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** Begin refused: a project gone, or no OAuth client registered with Cloudflare (503, nothing to retry). */
function beginError(
  caller: Caller,
  error: CloudflareConnectFailed | ProjectNotFound,
): Exclude<Delivery_beginCloudflareConnectResult, { readonly status: 200 }> {
  switch (error._tag) {
    case "ProjectNotFound":
      return notFound(caller);
    case "CloudflareConnectFailed":
      return {
        status: 503 as const,
        body: problem(503, "cloudflare.not_configured", caller.requestId, {
          detail:
            "This Keel has no OAuth client registered with Cloudflare, so no account can be connected through it yet.",
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

type Outcome = Extract<
  Delivery_completeCloudflareConnectResult,
  { readonly status: 303 }
>["headers"]["keel-cloudflare-outcome"];

/** What a Connect that did not finish comes to, for the owner's settings to say. */
export function outcomeOf(error: Exclude<CloudflareConnectError, ProjectNotFound>): Outcome {
  switch (error._tag) {
    case "ConnectStateRefused":
      return "expired";
    case "ConnectAccountsRefused":
      return "accounts";
    case "CloudflareConnectFailed":
      return "refused";
    case "DeployTargetUnreachable":
      return error.reason === "no-workers-dev" ? "no-workers-dev" : "unreachable";
    case "DeployTargetRefused":
      return error.reason === "too-many-targets" ? "full" : "refused";
    case "IdempotencyConflict":
      return "refused";
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** The project's namespace's handle and its own name: its address, and what a minted token is named by. */
const addressOf = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const place = yield* ProjectNamespaces.use((places) => places.byId(projectId));
    if (Option.isNone(place))
      return Option.none<{ readonly handle: string; readonly name: string }>();
    const record = yield* Namespaces.use((namespaces) => namespaces.byId(place.value.namespace));
    return Option.map(record, (found) => ({ handle: found.handle, name: place.value.name }));
  });

/** How a Connect ended, and for one Cloudflare refused, the step it refused. */
interface Ended {
  readonly outcome: Outcome;
  /** The step Cloudflare refused (`check` for the account's answer to Keel's token), and its own error code. */
  readonly refused?: { readonly step: string; readonly code?: number | undefined };
}

const ended = (
  outcome: Outcome,
  refusal?: { readonly step: string; readonly code?: number | undefined },
): Ended =>
  refusal === undefined
    ? { outcome }
    : {
        outcome,
        refused:
          refusal.code === undefined
            ? { step: refusal.step }
            : { step: refusal.step, code: refusal.code },
      };

/** The project's settings, where its owner is sent back with how the Connect ended. */
const settingsAt = (address: { readonly handle: string; readonly name: string }, end: Ended) =>
  `/${encodeURIComponent(address.handle)}/${encodeURIComponent(address.name)}/settings?cloudflare=${end.outcome}${end.refused === undefined ? "" : `&step=${end.refused.step}${end.refused.code === undefined ? "" : `&code=${end.refused.code}`}`}`;

/** The person the policy granted: credentials and deploy targets are recorded as a user's. */
function userOf(caller: Caller): Effect.Effect<UserId> {
  return caller.principal._tag === "User"
    ? Effect.succeed(caller.principal.userId)
    : Effect.die(
        new Error("a namespace's credentials or a project's deploy targets ran without a user"),
      );
}

/** The namespace the call was decided on, as `authorizeHandlers` resolved it. */
function namespaceOf(caller: Caller): NamespaceId {
  if (caller.resource?._tag !== "Namespace")
    throw new Error("a namespace's credentials ran without the namespace resolved");
  return caller.resource.namespace;
}

/** The project the call was decided on, as `authorizeHandlers` resolved it. */
function projectOf(caller: Caller) {
  if (caller.resource?._tag !== "Project")
    throw new Error("a project's deploy targets ran without the project resolved");
  return caller.resource;
}

/** The operations on a namespace's credentials and a project's deploy targets, and connecting a Cloudflare account to one. */
export function deliveryHandlers(run: Runner) {
  return {
    Delivery_createCredential: (caller: Caller, input: Input<"Delivery_createCredential">) => {
      const label = decodeWith(Schema.Struct({ label: CredentialLabel }), { label: input.label });
      if (Result.isFailure(label)) return invalid(caller, label.failure);
      return run(
        caller,
        userOf(caller).pipe(
          Effect.flatMap((by) =>
            CredentialStore.use((store) =>
              store.put(namespaceOf(caller), {
                label: label.success.label,
                provider: input.provider,
                secret: Redacted.make(input.secret),
                by,
              }),
            ),
          ),
          Effect.map(
            (meta) =>
              ({
                status: 201 as const,
                body: credentialView(meta),
              }) satisfies Delivery_createCredentialResult,
          ),
        ),
      );
    },
    Delivery_listCredentials: (caller: Caller, _input: Input<"Delivery_listCredentials">) =>
      run(
        caller,
        CredentialStore.use((store) => store.list(namespaceOf(caller))).pipe(
          Effect.map(
            (credentials) =>
              ({
                status: 200 as const,
                body: { credentials: credentials.map(credentialView) },
              }) satisfies Delivery_listCredentialsResult,
          ),
        ),
      ),
    Delivery_deleteCredential: (caller: Caller, input: Input<"Delivery_deleteCredential">) => {
      const id = decodeCredentialId(input.credentialId);
      if (Option.isNone(id)) return notFound(caller);
      return run(
        caller,
        userOf(caller).pipe(
          Effect.flatMap((by) =>
            CredentialStore.use((store) => store.remove(namespaceOf(caller), id.value, by)),
          ),
          Effect.match({
            onSuccess: () => ({ status: 204 as const }),
            onFailure: () => notFound(caller, `The namespace holds no credential ${id.value}.`),
          }),
        ),
      );
    },
    Delivery_putDeployTarget: (caller: Caller, input: Input<"Delivery_putDeployTarget">) => {
      const target = decodeWith(DeployTarget, {
        name: input.name,
        provider: input.provider,
        accountId: input.accountId,
        credential: input.credential,
      });
      if (Result.isFailure(target)) return invalid(caller, target.failure);
      const project = projectOf(caller);
      return run(
        caller,
        userOf(caller).pipe(
          Effect.flatMap((by) =>
            putDeployTarget({
              projectId: project.projectId,
              namespaceId: project.namespace,
              target: target.success,
              by,
              requestId: caller.requestId,
            }),
          ),
          Effect.match({
            onSuccess: (held) => ({ status: 200 as const, body: targetView(held) }),
            onFailure: (error) => putTargetError(caller, error),
          }),
        ),
      );
    },
    Delivery_listDeployTargets: (caller: Caller, _input: Input<"Delivery_listDeployTargets">) =>
      run(
        caller,
        listDeployTargets(projectOf(caller).projectId).pipe(
          Effect.match({
            onSuccess: (targets) =>
              ({
                status: 200 as const,
                body: { targets: targets.map(targetView) },
              }) satisfies Delivery_listDeployTargetsResult,
            onFailure: () => notFound(caller),
          }),
        ),
      ),
    Delivery_beginCloudflareConnect: (
      caller: Caller,
      input: Input<"Delivery_beginCloudflareConnect">,
    ) => {
      const name = decodeTargetName(input.name);
      if (Option.isNone(name))
        return invalid(caller, [{ path: ["path", "name"], message: "Not a deploy target's name" }]);
      const project = projectOf(caller);
      return run(
        caller,
        userOf(caller).pipe(
          Effect.flatMap((by) =>
            beginCloudflareConnect({ projectId: project.projectId, target: name.value, by }),
          ),
          Effect.match({
            onSuccess: (url) =>
              ({
                status: 200 as const,
                body: { authorizeUrl: url },
              }) satisfies Delivery_beginCloudflareConnectResult,
            onFailure: (error) => beginError(caller, error),
          }),
        ),
      );
    },
    Delivery_completeCloudflareConnect: (
      caller: Caller,
      input: Input<"Delivery_completeCloudflareConnect">,
    ) => {
      const project = projectOf(caller);
      const state = readConnectState(input.state);
      // The policy decided on the project this state names, so it reads as one.
      if (Option.isNone(state)) return notFound(caller);
      const { nonce } = state.value;
      const { code } = input;
      return run(
        caller,
        Effect.gen(function* () {
          const by = yield* userOf(caller);
          const address = yield* addressOf(project.projectId);
          if (Option.isNone(address)) return notFound(caller);
          const finished =
            input.error !== undefined || code === undefined
              ? // Cloudflare's own refusal, or the owner's: the state is spent all the same.
                DeployTargets.use((targets) =>
                  targets.takeConnect({ projectId: project.projectId, by, nonce }),
                ).pipe(
                  Effect.catchTag("ConnectStateRefused", () => Effect.void),
                  Effect.as(ended(input.error === "access_denied" ? "denied" : "refused")),
                )
              : completeCloudflareConnect({
                  projectId: project.projectId,
                  namespaceId: project.namespace,
                  handle: address.value.handle,
                  project: address.value.name,
                  by,
                  nonce,
                  code,
                  requestId: caller.requestId,
                }).pipe(
                  Effect.as(ended("connected")),
                  Effect.catch((error) =>
                    error._tag === "ProjectNotFound"
                      ? Effect.fail(error)
                      : Effect.succeed(
                          ended(
                            outcomeOf(error),
                            error._tag === "CloudflareConnectFailed"
                              ? error
                              : error._tag === "DeployTargetUnreachable"
                                ? { step: "check", code: error.code }
                                : undefined,
                          ),
                        ),
                  ),
                );
          const outcome = yield* Effect.option(finished);
          if (Option.isNone(outcome)) return notFound(caller);
          return {
            status: 303 as const,
            headers: {
              location: settingsAt(address.value, outcome.value),
              "keel-cloudflare-outcome": outcome.value.outcome,
            },
          } satisfies Delivery_completeCloudflareConnectResult;
        }),
      );
    },
    Delivery_deleteDeployTarget: (caller: Caller, input: Input<"Delivery_deleteDeployTarget">) => {
      const name = decodeTargetName(input.name);
      if (Option.isNone(name))
        return notFound(caller, `The project has no deploy target named ${input.name}.`);
      return run(
        caller,
        userOf(caller).pipe(
          Effect.flatMap((by) =>
            removeDeployTarget({
              projectId: projectOf(caller).projectId,
              name: name.value,
              by,
              requestId: caller.requestId,
            }),
          ),
          Effect.match({
            onSuccess: () => ({ status: 204 as const }),
            onFailure: (error) => clearTargetError(caller, error),
          }),
        ),
      );
    },
  };
}
