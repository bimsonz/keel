import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import type {
  AppClaims,
  PresentedToken,
  TokenRefusal,
  TokenUnchecked,
} from "@keeltown/core/application/identity";
import { type AgentClaims, Handle, Scope } from "@keeltown/core/domain/identity";
import { AgentId, ProjectId, RunId, RunLabel, UserId } from "@keeltown/core/kernel";
import { APIError } from "better-auth/api";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import { Schema } from "effect";
import { PERSON_SCOPE } from "./apps.ts";
import { AUTH_BASE_PATH, type KeelAuth } from "./auth.ts";
import { KEY_ALGORITHMS } from "./key-proofs.ts";

export type { AppClaims, PresentedToken, TokenRefusal, TokenUnchecked };

/** The claims of a person's token an app holds: the person, the app it was given to, and its scopes. */
const PersonClaims = Schema.Struct({
  sub: UserId,
  azp: Schema.NonEmptyString,
  scope: Schema.String,
});
const asPersonClaims = Schema.decodeUnknownOption(PersonClaims);

/**
 * The door a token is presented at: the resource it must be for, and, at the
 * one door an app's token acts at, whether the person still allows the app.
 * At a door with no `apps`, a person's token is refused.
 */
export interface TokenDoor {
  readonly resource: string;
  readonly apps?: { readonly allowed: (userId: UserId, clientId: string) => Promise<boolean> };
}

/** An app's token at a door it does not act at, or whose person no longer allows it. */
const APP_REFUSED: TokenRefusal = {
  refused: "invalid_token",
  detail:
    "This token is an app's, acting as a person at Keel's MCP server alone, and only while that person allows the app: sign in through the app again.",
};

/** How old a request's proof may be. */
const PROOF_SECONDS = 60;

/** The claims Keel's own rule put on the token (`agentClaims`), beside the provider's. */
const Claims = Schema.Struct({
  sub: AgentId,
  scope: Schema.String,
  epoch: Schema.Int,
  prj: Schema.optional(ProjectId),
  handle: Schema.optional(Handle),
  run: Schema.optional(RunId),
  run_label: Schema.optional(RunLabel),
  cnf: Schema.optional(Schema.Struct({ jkt: Schema.String })),
});
const asClaims = Schema.decodeUnknownOption(Claims);
const asScopes = Schema.decodeUnknownOption(Schema.Array(Scope));

/** A token bound to no key beside a proof: the client believes it is bound, and nothing would check that. */
const NO_KEY_TO_PROVE: TokenRefusal = {
  refused: "invalid_token",
  detail: "A token bound to no key is presented as a plain bearer, with no DPoP proof.",
};

/**
 * The signing keys are read through Better Auth, never over HTTP, and kept for
 * the isolate under this key: they change monthly, and a key id not seen before
 * reads them again.
 */
const SIGNING_KEYS = {};

const NOT_A_TOKEN: TokenRefusal = {
  refused: "invalid_token",
  detail: "The token is not one Keel issued for this API, or it has expired.",
};

/** A check that threw for a reason that is not the token's: logged, and answered as not checked. */
function unchecked(reading: string, fault: unknown): TokenUnchecked {
  console.error("agent token not checked", { reading, fault });
  return { unchecked: true };
}

/**
 * Who a token Keel issued says is calling, once Better Auth's own checks pass:
 * the token's signature, issuer, audience and expiry, then its binding (RFC 9449
 * §7.1). An agent's token names the agent; a person's token names the person
 * and the app that holds it, and is taken only at a door with `apps` (Keel's
 * MCP server), with the scope `person`, and while the person's consent to the
 * app stands, read on every request. The audience is the door's resource: a token
 * issued for another of Keel's resources is refused here. A token bound to a
 * key needs the DPoP scheme and a proof made by that key for this request,
 * used once; a token bound to no key needs neither and is refused with either:
 * under the DPoP scheme, or as a bearer beside a `DPoP` header. The
 * proof's id is kept in Better Auth's own store until the proof would have
 * expired.
 *
 * A check that throws for a reason that is not the token's (the signing keys
 * could not be read, the proof's id could not be kept) is answered as not
 * checked, never as a refusal: the token may be good. Better Auth wraps every
 * fault of a proof in its own binding error, so any other throw out of the
 * binding check is the store's.
 */
export async function verifyAccessToken(
  auth: KeelAuth,
  origin: string,
  door: TokenDoor,
  presented: PresentedToken,
): Promise<AgentClaims | AppClaims | TokenRefusal | TokenUnchecked> {
  const { resource } = door;
  let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
  let keysUnread: { readonly fault: unknown } | undefined;
  try {
    payload = await verifyJwsAccessToken(presented.token, {
      jwksFetch: () =>
        auth.api.getJwks().catch((fault: unknown) => {
          keysUnread = { fault };
          throw fault;
        }),
      jwksCacheKey: SIGNING_KEYS,
      verifyOptions: {
        issuer: `${origin}${AUTH_BASE_PATH}`,
        audience: resource,
        typ: "at+jwt",
        algorithms: ["EdDSA"],
      },
    });
  } catch {
    return keysUnread === undefined ? NOT_A_TOKEN : unchecked("the signing keys", keysUnread.fault);
  }
  try {
    const { internalAdapter } = await auth.$context;
    await enforceDpopBinding({
      payload,
      authorization: { scheme: presented.scheme, token: presented.token },
      proofJwt: presented.proof,
      method: presented.method,
      url: presented.url,
      replayStore: createDpopReplayStore(internalAdapter),
      proofMaxAgeSeconds: PROOF_SECONDS,
      signingAlgorithms: KEY_ALGORITHMS,
    });
  } catch (error) {
    if (!isDpopBindingError(error)) return unchecked("the proof's id", error);
    return {
      refused: error.code,
      detail:
        "A token bound to a key needs `Authorization: DPoP <token>` and a DPoP proof made by that key for this method and URL, naming the token, used once.",
    };
  }
  const person = asPersonClaims(payload);
  if (person._tag === "Some") return appClaims(door, person.value);
  const claims = asClaims(payload);
  if (claims._tag === "None") return NOT_A_TOKEN;
  const scopes = asScopes(claims.value.scope.split(" ").filter(Boolean));
  if (scopes._tag === "None") return NOT_A_TOKEN;
  const { sub, epoch, prj, handle, run, run_label: label, cnf } = claims.value;
  if (cnf === undefined && presented.proof !== undefined) return NO_KEY_TO_PROVE;
  return {
    agentId: sub,
    ...(prj === undefined ? {} : { projectId: prj }),
    scopes: scopes.value,
    revocationEpoch: epoch,
    ...(handle === undefined ? {} : { handle }),
    ...(run === undefined ? {} : { run: { id: run, ...(label === undefined ? {} : { label }) } }),
    bound: cnf !== undefined,
  };
}

/** A person's token, as the door takes it: at the app door, for `person`, while the person allows the app. */
async function appClaims(
  door: TokenDoor,
  claims: typeof PersonClaims.Type,
): Promise<AppClaims | TokenRefusal | TokenUnchecked> {
  if (door.apps === undefined || !claims.scope.split(" ").includes(PERSON_SCOPE))
    return APP_REFUSED;
  let allowed: boolean;
  try {
    allowed = await door.apps.allowed(claims.sub, claims.azp);
  } catch (fault) {
    return unchecked("the person's consent", fault);
  }
  return allowed ? { userId: claims.sub, clientId: claims.azp } : APP_REFUSED;
}

/**
 * The `WWW-Authenticate` value of a 401 at `resource`, as Better Auth's
 * provider writes it: for a refused proof the `DPoP` challenge with the
 * algorithms a proof may use (RFC 9449 §7.1), otherwise the bearer challenge
 * naming the resource's metadata (RFC 9728), where a client reads which server
 * issues its tokens.
 */
export function resourceChallenge(resource: string, refusal?: TokenRefusal): string {
  const error = new APIError("UNAUTHORIZED", {
    message: refusal?.detail ?? NOT_A_TOKEN.detail,
    ...(refusal === undefined ? {} : { error: refusal.refused, error_description: refusal.detail }),
  });
  const challenge: unknown = createResourceServerChallenge(error, resource, {
    dpopSigningAlgorithms: KEY_ALGORITHMS,
  })?.headers;
  const value: unknown =
    challenge instanceof Headers
      ? challenge.get("www-authenticate")
      : typeof challenge === "object" && challenge !== null
        ? Reflect.get(challenge, "WWW-Authenticate")
        : undefined;
  if (typeof value !== "string") throw new Error(`no challenge was made for ${resource}`);
  return value;
}
