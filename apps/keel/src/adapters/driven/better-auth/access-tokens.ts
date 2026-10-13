import { type AgentClaims, Handle, Scope } from "@keeltown/core/domain/identity";
import { AgentId, ProjectId, RunId, RunLabel } from "@keeltown/core/kernel";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import { Schema } from "effect";
import { AUTH_BASE_PATH, type KeelAuth } from "./auth.ts";
import { KEY_ALGORITHMS } from "./key-proofs.ts";

/** An agent's token as a request presents it. */
export interface PresentedToken {
  readonly token: string;
  /** `DPoP` when the request says the token is bound to a key (RFC 9449 §7.1), else `Bearer`. */
  readonly scheme: "Bearer" | "DPoP";
  /** The request's DPoP proof, when it sent one. */
  readonly proof?: string | undefined;
  readonly method: string;
  /** Where the request was made: Keel's origin and the path, with no query. */
  readonly url: string;
}

/** Why a token is refused, in the codes RFC 6750 and RFC 9449 give them. */
export interface TokenRefusal {
  readonly refused: "invalid_token" | "invalid_dpop_proof";
  readonly detail: string;
}

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

/**
 * Who an agent's token says is calling, once Better Auth's own checks pass: the
 * token's signature, issuer, audience and expiry, then its binding (RFC 9449
 * §7.1). A token bound to a key needs the DPoP scheme and a proof made by that
 * key for this request, used once; a plain bearer needs neither and is refused
 * with either. The proof's id is kept in Better Auth's own store until the
 * proof would have expired.
 */
export async function verifyAgentToken(
  auth: KeelAuth,
  origin: string,
  presented: PresentedToken,
): Promise<AgentClaims | TokenRefusal> {
  let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
  try {
    payload = await verifyJwsAccessToken(presented.token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: SIGNING_KEYS,
      verifyOptions: {
        issuer: `${origin}${AUTH_BASE_PATH}`,
        audience: origin,
        typ: "at+jwt",
        algorithms: ["EdDSA"],
      },
    });
  } catch {
    return NOT_A_TOKEN;
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
    return {
      refused: isDpopBindingError(error) ? error.code : "invalid_dpop_proof",
      detail:
        "A token bound to a key needs `Authorization: DPoP <token>` and a DPoP proof made by that key for this method and URL, naming the token, used once.",
    };
  }
  const claims = asClaims(payload);
  if (claims._tag === "None") return NOT_A_TOKEN;
  const scopes = asScopes(claims.value.scope.split(" ").filter(Boolean));
  if (scopes._tag === "None") return NOT_A_TOKEN;
  const { sub, epoch, prj, handle, run, run_label: label, cnf } = claims.value;
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
