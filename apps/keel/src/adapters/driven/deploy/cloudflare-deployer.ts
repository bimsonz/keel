import { DeploymentFailed } from "@keeltown/core/domain/delivery";
import type { Json } from "@keeltown/core/kernel";
import { type DeployAccount, Deployer, type WorkerUpload } from "@keeltown/core/ports";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  CLOUDFLARE_API,
  type CloudflareApiOptions,
  type Fetcher,
  TOKEN_REFUSED,
} from "./cloudflare-api.ts";

/** How long one call's answer is waited for: an upload carries the whole module. */
const ANSWER_MS = 30_000;

/** The date the script subdomain API is asked at, which reads and sets previews beside workers.dev. */
const SCRIPT_API_DATE = "2025-08-01";

const Envelope = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.optional(Schema.String) })),
  ),
  result: Schema.optional(Schema.Unknown),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const IdResult = Schema.Struct({ id: Schema.String });
const decodeId = Schema.decodeUnknownOption(IdResult);
const SubdomainResult = Schema.Struct({ previews_enabled: Schema.optional(Schema.Boolean) });
const decodeSubdomain = Schema.decodeUnknownOption(SubdomainResult);

type Operation = DeploymentFailed["operation"];
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A version's addresses, as Cloudflare forms them: its id's first eight characters, or its alias, before the Worker's name. */
export const versionUrl = (prefix: string, worker: string, account: DeployAccount): string =>
  `https://${prefix}-${worker}.${account.workersDev}`;

/**
 * Why an answer that was not a success failed: a token Cloudflare refused
 * (401, 403 or a code it gives for a bad token), the provider out of reach (no
 * answer, a 5xx, or nothing readable), or what was sent refused, with
 * Cloudflare's first code and message, which are the change's to read.
 */
export const failureOf = (operation: Operation, answer: Answer): DeploymentFailed => {
  const envelope = Option.getOrUndefined(decodeEnvelope(answer.body));
  const first = envelope?.errors?.[0];
  const code = first === undefined ? {} : { code: first.code };
  const said = first?.message === undefined ? "" : `: ${first.message}`;
  if (
    answer.status === 401 ||
    answer.status === 403 ||
    envelope?.errors?.some((e) => TOKEN_REFUSED.has(e.code)) === true
  )
    return new DeploymentFailed({
      operation,
      reason: "token-refused",
      detail: `Cloudflare refused the deploy target's token (${answer.status})${said}`,
      ...code,
    });
  if (answer.status === 0 || answer.status >= 500 || envelope === undefined)
    return new DeploymentFailed({
      operation,
      reason: "unreachable",
      detail:
        answer.status === 0
          ? "Cloudflare did not answer"
          : `Cloudflare answered ${answer.status}${said}`,
      ...code,
    });
  return new DeploymentFailed({
    operation,
    reason: "refused",
    detail: `Cloudflare refused it (${answer.status})${said}`,
    ...code,
  });
};

const ok = (answer: Answer): boolean =>
  answer.status >= 200 &&
  answer.status < 300 &&
  Option.getOrUndefined(decodeEnvelope(answer.body))?.success !== false;
const resultOf = (answer: Answer): unknown =>
  Option.getOrUndefined(decodeEnvelope(answer.body))?.result;
const account = (a: DeployAccount) => `/accounts/${encodeURIComponent(a.accountId)}`;

/** The bindings a version is sent with: its plain vars, and nothing else. */
const bindingsOf = (vars: Readonly<Record<string, Json>>) =>
  Object.entries(vars).map(([name, value]) =>
    typeof value === "string"
      ? { type: "plain_text", name, text: value }
      : { type: "json", name, json: value },
  );

/**
 * The multipart body of a version upload. Its bindings are only the config's
 * plain vars, and it never asks Cloudflare to keep any binding of the Worker's
 * deployed version (`keep_bindings`): a preview of a change's code must not run
 * with production's secrets.
 */
export const versionForm = (upload: WorkerUpload): FormData => {
  const form = new FormData();
  const metadata = {
    main_module: upload.mainModule,
    compatibility_date: upload.compatibilityDate,
    compatibility_flags: upload.compatibilityFlags,
    bindings: bindingsOf(upload.vars),
    annotations: {
      "workers/message": upload.message,
      "workers/tag": upload.tag,
      ...(upload.alias === undefined ? {} : { "workers/alias": upload.alias }),
    },
  };
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set(
    upload.mainModule,
    new Blob([upload.module], { type: "application/javascript+module" }),
    upload.mainModule,
  );
  return form;
};

/**
 * `Deployer` over Cloudflare's REST API, with the deploy target's token as a
 * bearer on each call and nowhere else.
 *
 * A preview reads the Worker (`GET …/workers/workers/{name}`). An account
 * with none of that name gets one made with no code and no deployment, its
 * workers.dev address and version addresses on, so a first preview never puts
 * a change live. An existing Worker whose version addresses are off is
 * `previews-off`: turning them on is the owner's call, not Keel's. Then the
 * version is uploaded (`…/versions?bindings_inherit=strict`), never deployed,
 * and its addresses formed from its id and alias.
 */
export function DeployerCloudflare(options: CloudflareApiOptions = {}): Layer.Layer<Deployer> {
  const send: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.base ?? CLOUDFLARE_API;
  const call = (
    token: Redacted.Redacted,
    method: string,
    path: string,
    body?: FormData | object,
    headers: Record<string, string> = {},
  ): Effect.Effect<Answer> =>
    Effect.promise(async (signal) => {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${Redacted.value(token)}`,
            accept: "application/json",
            ...(body === undefined || body instanceof FormData
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: body instanceof FormData ? body : JSON.stringify(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_MS)]),
        });
        const read: unknown = await response.json().catch(() => undefined);
        return { status: response.status, body: read };
      } catch {
        return { status: 0, body: undefined };
      }
    });
  const ensureWorker = (a: DeployAccount, token: Redacted.Redacted, worker: string) =>
    Effect.gen(function* () {
      const name = encodeURIComponent(worker);
      const read = yield* call(token, "GET", `${account(a)}/workers/workers/${name}`);
      if (read.status === 404) {
        const made = yield* call(token, "POST", `${account(a)}/workers/workers`, {
          name: worker,
          subdomain: { enabled: true, previews_enabled: true },
        });
        if (!ok(made)) return yield* Effect.fail(failureOf("preview", made));
        return yield* Effect.void;
      }
      if (!ok(read)) return yield* Effect.fail(failureOf("preview", read));
      const subdomain = yield* call(
        token,
        "GET",
        `${account(a)}/workers/scripts/${name}/subdomain`,
        undefined,
        { "Cloudflare-Workers-Script-Api-Date": SCRIPT_API_DATE },
      );
      if (!ok(subdomain)) return yield* Effect.fail(failureOf("preview", subdomain));
      const previews = Option.getOrUndefined(decodeSubdomain(resultOf(subdomain)));
      if (previews?.previews_enabled === false)
        return yield* Effect.fail(
          new DeploymentFailed({
            operation: "preview",
            reason: "previews-off",
            detail: `${worker}'s version addresses are off on the account: an owner turns them on in the Worker's Domains tab (Preview URLs), or with preview_urls: true`,
          }),
        );
      return yield* Effect.void;
    });

  return Layer.succeed(
    Deployer,
    Deployer.of({
      preview: (a, token, upload) =>
        Effect.gen(function* () {
          yield* ensureWorker(a, token, upload.worker);
          const uploaded = yield* call(
            token,
            "POST",
            `${account(a)}/workers/scripts/${encodeURIComponent(upload.worker)}/versions?bindings_inherit=strict`,
            versionForm(upload),
          );
          if (!ok(uploaded)) return yield* Effect.fail(failureOf("preview", uploaded));
          const version = Option.getOrUndefined(decodeId(resultOf(uploaded)));
          if (version === undefined)
            return yield* Effect.fail(
              failureOf("preview", { status: uploaded.status, body: undefined }),
            );
          return {
            versionId: version.id,
            url: versionUrl(version.id.slice(0, 8), upload.worker, a),
            ...(upload.alias === undefined
              ? {}
              : { aliasUrl: versionUrl(upload.alias, upload.worker, a) }),
          };
        }),
      promote: (a, token, deploy) =>
        Effect.gen(function* () {
          const answer = yield* call(
            token,
            "POST",
            `${account(a)}/workers/scripts/${encodeURIComponent(deploy.worker)}/deployments`,
            {
              strategy: "percentage",
              versions: [{ version_id: deploy.versionId, percentage: 100 }],
              annotations: { "workers/message": deploy.message },
            },
          );
          if (!ok(answer)) return yield* Effect.fail(failureOf("promote", answer));
          const made = Option.getOrUndefined(decodeId(resultOf(answer)));
          if (made === undefined)
            return yield* Effect.fail(
              failureOf("promote", { status: answer.status, body: undefined }),
            );
          return { deploymentId: made.id };
        }),
      deleteVersion: (a, token, version) =>
        Effect.gen(function* () {
          const answer = yield* call(
            token,
            "DELETE",
            `${account(a)}/workers/workers/${encodeURIComponent(version.worker)}/versions/${encodeURIComponent(version.versionId)}`,
          );
          if (!ok(answer) && answer.status !== 404)
            return yield* Effect.fail(failureOf("delete-version", answer));
          return yield* Effect.void;
        }),
    }),
  );
}
