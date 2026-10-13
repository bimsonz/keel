import { DeployTargetUnreachable } from "@keeltown/core/domain/delivery";
import { DeployTargetCheck, type TargetReach } from "@keeltown/core/ports";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";

/** Cloudflare's REST API, version 4. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** How long the account's answer is waited for before the target is called unreachable. */
const ANSWER_MS = 10_000;

/** The error code Cloudflare answers for an account with no workers.dev subdomain. */
export const NO_SUBDOMAIN = 10_007;

/**
 * The codes Cloudflare answers for a token it does not take: authentication
 * failed (10000), an invalid token (9109), an invalid or malformed
 * `Authorization` header (6003, 6111).
 */
export const TOKEN_REFUSED: ReadonlySet<number> = new Set([10_000, 9109, 6003, 6111]);

/** Cloudflare's response envelope, as much of it as is read: every other field is ignored. */
const Envelope = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  errors: Schema.optional(Schema.Array(Schema.Struct({ code: Schema.Number }))),
  result: Schema.optional(
    Schema.NullOr(Schema.Struct({ subdomain: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

const unreachable = (
  reason: DeployTargetUnreachable["reason"],
  code: number | undefined,
): Result.Result<TargetReach, DeployTargetUnreachable> =>
  Result.fail(new DeployTargetUnreachable(code === undefined ? { reason } : { reason, code }));

/**
 * What an account's answer to `GET /accounts/{id}/workers/subdomain` says of
 * a target: the subdomain its previews are served under, or why it cannot
 * serve one. No subdomain (10007, or a success that names none) is the
 * owner's to set; a token Cloudflare refused (401, or a code it gives for a
 * bad token) is `token-invalid`; anything else, a 403 among them, is
 * `account-unreachable`, with the first code Cloudflare gave.
 */
export function reachOf(
  status: number,
  body: unknown,
): Result.Result<TargetReach, DeployTargetUnreachable> {
  const envelope = Option.getOrUndefined(decodeEnvelope(body));
  const codes = envelope?.errors?.map((error) => error.code) ?? [];
  if (status === 200 && envelope?.success !== false && envelope?.result !== undefined) {
    const subdomain = envelope.result?.subdomain;
    return subdomain === undefined || subdomain === null || subdomain === ""
      ? unreachable("no-workers-dev", undefined)
      : Result.succeed({ workersDev: `${subdomain}.workers.dev` });
  }
  if (codes.includes(NO_SUBDOMAIN)) return unreachable("no-workers-dev", NO_SUBDOMAIN);
  const refused = codes.find((code) => TOKEN_REFUSED.has(code));
  if (status === 401 || refused !== undefined)
    return unreachable("token-invalid", refused ?? codes[0]);
  return unreachable("account-unreachable", codes[0]);
}

/** How the adapter reaches Cloudflare: `fetch` by default, resolved at each call, so a test may stand in for it. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudflareApiOptions {
  readonly fetch?: Fetcher;
  readonly base?: string;
}

/**
 * `DeployTargetCheck` over Cloudflare's REST API: one read of the account's
 * workers.dev subdomain, with the credential as a bearer. The secret is opened
 * only into that header; a request that fails or answers nothing readable is
 * `account-unreachable`, and nothing about it is logged.
 */
export function DeployTargetCheckCloudflare(
  options: CloudflareApiOptions = {},
): Layer.Layer<DeployTargetCheck> {
  const send: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.base ?? CLOUDFLARE_API;
  const ask = async (url: string, secret: Redacted.Redacted, signal: AbortSignal) => {
    try {
      const response = await send(url, {
        method: "GET",
        headers: { authorization: `Bearer ${Redacted.value(secret)}`, accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_MS)]),
      });
      const body: unknown = await response.json().catch(() => undefined);
      return { status: response.status, body };
    } catch {
      return { status: 0, body: undefined };
    }
  };
  return Layer.succeed(
    DeployTargetCheck,
    DeployTargetCheck.of({
      reach: (accountId, secret) =>
        Effect.promise((signal) =>
          ask(
            `${base}/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
            secret,
            signal,
          ),
        ).pipe(Effect.flatMap(({ status, body }) => Effect.fromResult(reachOf(status, body)))),
    }),
  );
}
