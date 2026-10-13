import { KeyThumbprint, type PresentedKey, PublicJwk } from "@keeltown/core/domain/identity";
import { deriveDpopJkt, verifyDpopProof } from "better-auth/oauth2";
import { Schema } from "effect";

/** Why a sign-up's key or its proof was refused, in the codes RFC 7591 and RFC 9449 give them. */
export interface KeyRefusal {
  readonly refused: "invalid_client_metadata" | "invalid_dpop_proof";
  readonly detail: string;
}

/** The algorithms an agent's key signs with: Ed25519, and P-256 for keys a hardware store holds. */
export const KEY_ALGORITHMS = ["EdDSA", "ES256"] as const;

/** How old a sign-up's proof may be. */
const PROOF_SECONDS = 60;

const asPublicJwk = Schema.decodeUnknownOption(PublicJwk);
const asThumbprint = Schema.decodeUnknownOption(KeyThumbprint);

/**
 * The key a sign-up registers, once its holder has proved it: a DPoP proof
 * (RFC 9449) made by that same key for this request. Better Auth's own check
 * reads the proof's signature, type, method, URL and age. No replay store: a
 * replayed sign-up is the same sign-up, and reaches the same account.
 */
export async function provenKey(request: {
  readonly jwk: unknown;
  readonly proof: string | undefined;
  readonly url: string;
}): Promise<PresentedKey | KeyRefusal> {
  const jwk = asPublicJwk(request.jwk);
  if (jwk._tag === "None")
    return {
      refused: "invalid_client_metadata",
      detail: "Send one public key as a JWK: Ed25519 or P-256.",
    };
  const jkt = asThumbprint(await deriveDpopJkt(jwk.value));
  if (jkt._tag === "None")
    return { refused: "invalid_client_metadata", detail: "The key has no thumbprint." };
  if (request.proof === undefined)
    return {
      refused: "invalid_dpop_proof",
      detail:
        "Send a DPoP proof (RFC 9449) in the DPoP header, made by the key being registered, for this method and URL.",
    };
  try {
    await verifyDpopProof({
      proofJwt: request.proof,
      method: "POST",
      url: request.url,
      expectedJkt: jkt.value,
      proofMaxAgeSeconds: PROOF_SECONDS,
      signingAlgorithms: KEY_ALGORITHMS,
    });
  } catch {
    return {
      refused: "invalid_dpop_proof",
      detail:
        "The proof must be made by the key being registered, for this method and URL, within the last minute.",
    };
  }
  return { jkt: jkt.value, jwk: jwk.value };
}
