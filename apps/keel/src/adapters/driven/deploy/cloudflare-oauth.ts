import {
  CloudflareConnectFailed,
  connectState,
  type GrantedAccount,
} from "@keeltown/core/domain/delivery";
import { CloudflareOAuth, type ConsentStart } from "@keeltown/core/ports";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { CLOUDFLARE_API, type Fetcher } from "./cloudflare-api.ts";

/** Cloudflare's consent screen for a self-managed OAuth client. */
export const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";

/** Where a code is exchanged for an access token. */
export const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

/**
 * The scopes Keel's client asks for, which are all its registration holds: to
 * mint the token it deploys with on the account the owner ticks, to read which
 * account that was, and Workers Scripts Write itself, since a token may only be
 * given permissions its maker holds. Keel deploys with the minted token alone,
 * which may only edit that account's Workers; the consent's own access is used
 * for the mint and dropped.
 */
export const CLOUDFLARE_SCOPES = [
  "account-api-tokens.write",
  "account-settings.read",
  "workers-scripts.write",
] as const;

/** The one permission the minted token holds, found by this name among the account's permission groups. */
export const WORKERS_SCRIPTS_WRITE = "Workers Scripts Write";

/** How long each of Cloudflare's answers is waited for. */
const ANSWER_MS = 10_000;

/** 32 random bytes, base64url: 43 characters, as RFC 7636 asks of a verifier. */
const RANDOM_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const random = () => base64url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));

/** The S256 challenge of a verifier. */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * `application/x-www-form-urlencoded`, as RFC 6749 § 2.3.1 encodes each half
 * of a Basic credential: unlike `encodeURIComponent`, it escapes `!'()~` and
 * writes a space as `+`, and Cloudflare decodes the halves by it.
 */
export function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

/** Cloudflare's v4 envelope, as much as is read. */
const Envelope = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.optional(Schema.String) })),
  ),
  result: Schema.optional(Schema.Unknown),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const Accounts = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const decodeAccounts = Schema.decodeUnknownOption(Accounts);
const Groups = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const decodeGroups = Schema.decodeUnknownOption(Groups);
const Minted = Schema.Struct({ value: Schema.String.check(Schema.isMinLength(1)) });
const decodeMinted = Schema.decodeUnknownOption(Minted);
const Exchanged = Schema.Struct({ access_token: Schema.String.check(Schema.isMinLength(1)) });
const decodeExchanged = Schema.decodeUnknownOption(Exchanged);
const OAuthError = Schema.Struct({ error: Schema.optional(Schema.String) });
const decodeOAuthError = Schema.decodeUnknownOption(OAuthError);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A step Cloudflare refused, logged with what it said of it: the call, its
 * status, and Cloudflare's own error codes and messages, or the OAuth error's
 * name. Never a token, a code, a verifier or the secret: none is in an answer.
 */
const failed = (step: CloudflareConnectFailed["step"], answer?: Answer, call?: string) => {
  const errors = Option.getOrUndefined(decodeEnvelope(answer?.body))?.errors ?? [];
  const code = errors[0]?.code;
  console.warn("Cloudflare refused a Connect step", {
    step,
    call: call ?? step,
    status: answer?.status ?? null,
    errors: errors.map((error) => `${error.code} ${error.message ?? ""}`.trim()),
    oauthError: Option.getOrUndefined(decodeOAuthError(answer?.body))?.error ?? null,
  });
  return new CloudflareConnectFailed({
    step,
    ...(answer === undefined ? {} : { status: answer.status }),
    ...(code === undefined ? {} : { code }),
  });
};

/** A v4 answer's `result` when Cloudflare says it succeeded (a 2xx, not `success: false`), else none. */
const resultOf = (answer: Answer): Option.Option<unknown> =>
  answer.status >= 200 && answer.status < 300
    ? Option.flatMap(decodeEnvelope(answer.body), (envelope) =>
        envelope.success === false ? Option.none() : Option.fromUndefinedOr(envelope.result),
      )
    : Option.none();

/** The consent's access token as a bearer, for the account read and the mint. */
const bearer = (access: Redacted.Redacted) => ({
  authorization: `Bearer ${Redacted.value(access)}`,
  accept: "application/json",
});

export interface CloudflareOAuthOptions {
  /** The registered client's id: empty while this Keel has none, and then every step is `unconfigured`. */
  readonly clientId: string;
  /** The client's secret, read only to exchange a code. */
  readonly clientSecret: () => Promise<string>;
  /** Byte for byte a redirect URI the client is registered with. */
  readonly redirectUri: string;
  readonly fetch?: Fetcher;
  readonly api?: string;
}

/**
 * `CloudflareOAuth` over Cloudflare's endpoints, as a confidential client
 * (`client_secret_basic`) that also sends PKCE. The access token a code is
 * exchanged for is opened only into the headers of the account read and the
 * mint, and nothing about a token, a code, a verifier or the secret is logged:
 * a refused exchange logs Cloudflare's status and its OAuth error name.
 */
export function CloudflareOAuthLive(options: CloudflareOAuthOptions): Layer.Layer<CloudflareOAuth> {
  const send: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const api = options.api ?? CLOUDFLARE_API;
  const configured = options.clientId !== "";
  const ask = async (url: string, init: RequestInit, signal: AbortSignal): Promise<Answer> => {
    try {
      const response = await send(url, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_MS)]),
      });
      const body: unknown = await response.json().catch(() => undefined);
      return { status: response.status, body };
    } catch {
      return { status: 0, body: undefined };
    }
  };
  const unconfigured = Effect.fail(new CloudflareConnectFailed({ step: "unconfigured" }));

  return Layer.succeed(
    CloudflareOAuth,
    CloudflareOAuth.of({
      begin: (projectId) =>
        configured
          ? Effect.promise(async (): Promise<ConsentStart> => {
              const nonce = random();
              const verifier = random();
              const query = new URLSearchParams({
                response_type: "code",
                client_id: options.clientId,
                redirect_uri: options.redirectUri,
                scope: CLOUDFLARE_SCOPES.join(" "),
                state: connectState(projectId, nonce),
                code_challenge: await challengeOf(verifier),
                code_challenge_method: "S256",
              });
              return { url: `${AUTHORIZE_URL}?${query.toString()}`, nonce, verifier };
            })
          : unconfigured,

      exchange: (code, verifier) =>
        configured
          ? Effect.tryPromise({
              try: () => options.clientSecret(),
              catch: () => new CloudflareConnectFailed({ step: "unconfigured" }),
            }).pipe(
              Effect.flatMap((secret) =>
                Effect.promise((signal) =>
                  ask(
                    TOKEN_URL,
                    {
                      method: "POST",
                      headers: {
                        authorization: `Basic ${btoa(`${formEncode(options.clientId)}:${formEncode(secret)}`)}`,
                        "content-type": "application/x-www-form-urlencoded",
                        accept: "application/json",
                      },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code,
                        redirect_uri: options.redirectUri,
                        code_verifier: verifier,
                        client_id: options.clientId,
                      }).toString(),
                    },
                    signal,
                  ),
                ),
              ),
              Effect.flatMap((answer) => {
                const exchanged =
                  answer.status === 200 ? decodeExchanged(answer.body) : Option.none();
                if (Option.isSome(exchanged))
                  return Effect.succeed(Redacted.make(exchanged.value.access_token));
                return Effect.fail(failed("exchange", answer));
              }),
            )
          : unconfigured,

      accounts: (access) =>
        Effect.promise((signal) =>
          ask(`${api}/accounts`, { method: "GET", headers: bearer(access) }, signal),
        ).pipe(
          Effect.flatMap((answer) =>
            Option.match(Option.flatMap(resultOf(answer), decodeAccounts), {
              onNone: () => Effect.fail(failed("accounts", answer)),
              onSome: (accounts): Effect.Effect<readonly GrantedAccount[]> =>
                Effect.succeed(accounts.map(({ id, name }) => ({ id, name }))),
            }),
          ),
        ),

      mint: (access, accountId, name) =>
        Effect.gen(function* () {
          const account = `${api}/accounts/${encodeURIComponent(accountId)}`;
          const groups = yield* Effect.promise((signal) =>
            ask(
              `${account}/tokens/permission_groups?${new URLSearchParams({ name: WORKERS_SCRIPTS_WRITE }).toString()}`,
              { method: "GET", headers: bearer(access) },
              signal,
            ),
          );
          const group = Option.getOrUndefined(Option.flatMap(resultOf(groups), decodeGroups))?.find(
            (found) => found.name === WORKERS_SCRIPTS_WRITE,
          );
          if (group === undefined)
            return yield* Effect.fail(failed("mint", groups, "permission groups"));
          const minted = yield* Effect.promise((signal) =>
            ask(
              `${account}/tokens`,
              {
                method: "POST",
                headers: { ...bearer(access), "content-type": "application/json" },
                body: JSON.stringify({
                  name,
                  policies: [
                    {
                      effect: "allow",
                      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                      permission_groups: [{ id: group.id }],
                    },
                  ],
                }),
              },
              signal,
            ),
          );
          const token = Option.getOrUndefined(Option.flatMap(resultOf(minted), decodeMinted));
          if (token === undefined)
            return yield* Effect.fail(failed("mint", minted, "create token"));
          return Redacted.make(token.value);
        }),
    }),
  );
}
