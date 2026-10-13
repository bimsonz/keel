import { Schema } from "effect";
import { type AgentId, InstantSchema, makeId } from "../kernel/index.ts";
import type { Handle } from "./handle.ts";

/**
 * A public key's thumbprint (RFC 7638): the SHA-256 of its canonical JWK, in
 * base64url without padding. It names the key wherever Keel names one.
 */
export const KeyThumbprint = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)).pipe(
  Schema.brand("KeyThumbprint"),
);
export type KeyThumbprint = typeof KeyThumbprint.Type;

/**
 * A public key an agent may sign with, as a JWK: Ed25519 or P-256 (what
 * hardware key stores hold). The schema names only public members, so a private
 * part never reaches a record.
 */
export const PublicJwk = Schema.Union([
  Schema.Struct({
    kty: Schema.Literal("OKP"),
    crv: Schema.Literal("Ed25519"),
    x: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.NonEmptyString,
    y: Schema.NonEmptyString,
  }),
]);
export type PublicJwk = typeof PublicJwk.Type;

/** A key as an agent presents it: the key and the thumbprint Keel computed for it. */
export const PresentedKey = Schema.Struct({ jkt: KeyThumbprint, jwk: PublicJwk });
export type PresentedKey = typeof PresentedKey.Type;

/** One of an agent's keys, with when it was added. */
export const AgentKey = Schema.Struct({ ...PresentedKey.fields, addedAt: InstantSchema });
export type AgentKey = typeof AgentKey.Type;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The agent a key signs up as: `agt_` and the thumbprint's first 128 bits in
 * the id alphabet. The id is a function of the key alone, so signing up twice
 * with one key reaches one account, and no other key names it.
 */
export function agentIdOf(thumbprint: KeyThumbprint): AgentId {
  // 22 characters hold 132 bits; the id takes the first 128.
  let bits = 0n;
  for (const character of thumbprint.slice(0, 22))
    bits = (bits << 6n) | BigInt(BASE64URL.indexOf(character));
  return makeId("agt", idBody(bits >> 4n));
}

/** An id's body for 128 bits: 26 characters of the id alphabet. */
export function idBody(bits: bigint): string {
  let rest = bits;
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    body = CROCKFORD.charAt(Number(rest & 31n)) + body;
    rest >>= 5n;
  }
  return body;
}

/** How many characters of an agent's id its given handle carries: 78 bits of its key. */
const HANDLE_CHARACTERS = 16;

/**
 * The handle an agent is given at sign-up: made from its id, so from its key,
 * and never chosen. A readable name is claimed for it separately.
 */
export function givenHandle(agentId: AgentId): Handle {
  return `agent-${agentId.slice("agt_".length, "agt_".length + HANDLE_CHARACTERS).toLowerCase()}`;
}
