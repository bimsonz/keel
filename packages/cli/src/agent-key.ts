import { type AgentSigner, type PrivateJwk, signerFromJwk } from "@keeltown/sdk";
import type { KeyStore } from "./key-store.ts";

/** The agent this machine holds a key for, on one Keel host: who it signed up as, and how it signs. */
export interface Held {
  readonly signer: AgentSigner;
  /** The agent's id, once it has signed up. */
  readonly agentId?: string;
  readonly handle?: string;
  /** Where the key is held, in words a person reads. */
  readonly where: string;
  /** The private key, when this machine's key store holds it and so may be written back to. */
  readonly stored?: PrivateJwk;
}

/** What a key store entry holds: the key, and who it signed up as. */
interface Entry {
  readonly jwk: PrivateJwk;
  readonly agentId?: string;
  readonly handle?: string;
}

/** A second agent on one machine is filed under a profile: lower-case letters, digits and hyphens. */
const PROFILE = /^[a-z0-9-]+$/;

/** A key that is not one, or an entry that does not read as one: the command line's or the environment's mistake. */
export class KeyError extends Error {}

/** The key store entry for a Keel host: its host, and `#<profile>` for any agent but the first. */
export function entryName(baseUrl: string, profile: string | undefined): string {
  if (profile !== undefined && !PROFILE.test(profile))
    throw new KeyError("--profile takes lower-case letters, digits and hyphens");
  const host = URL.parse(baseUrl)?.host;
  if (host === undefined || host === "") throw new KeyError("KEEL_URL is not a URL");
  return profile === undefined ? host : `${host}#${profile}`;
}

const text = (value: unknown, name: string): string | undefined => {
  const member: unknown = Reflect.get(Object(value), name);
  return typeof member === "string" && member !== "" ? member : undefined;
};

function privateJwk(value: unknown): PrivateJwk | undefined {
  const x = text(value, "x");
  const d = text(value, "d");
  return text(value, "kty") === "OKP" &&
    text(value, "crv") === "Ed25519" &&
    x !== undefined &&
    d !== undefined
    ? { kty: "OKP", crv: "Ed25519", x, d }
    : undefined;
}

/** An entry as the store keeps it: one base64url word, so it is safe wherever the store's own tool writes it. */
export const encodeEntry = (entry: Entry): string =>
  Buffer.from(JSON.stringify(entry), "utf8").toString("base64url");

function decodeEntry(secret: string): Entry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(secret, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const jwk = privateJwk(Reflect.get(Object(parsed), "jwk"));
  if (jwk === undefined) return undefined;
  const agentId = text(parsed, "agentId");
  const handle = text(parsed, "handle");
  return {
    jwk,
    ...(agentId === undefined ? {} : { agentId }),
    ...(handle === undefined ? {} : { handle }),
  };
}

/**
 * The key this machine holds for `entry`. `KEEL_AGENT_KEY` (the private JWK,
 * set by a secret manager where there is no key store) comes first, with
 * `KEEL_AGENT_ID` beside it; otherwise the key store. Undefined when neither
 * holds one.
 */
export async function heldKey(
  env: Readonly<Record<string, string | undefined>>,
  store: KeyStore | undefined,
  entry: string,
): Promise<Held | undefined> {
  const given = env["KEEL_AGENT_KEY"];
  if (given !== undefined && given !== "") {
    let jwk: PrivateJwk | undefined;
    try {
      jwk = privateJwk(JSON.parse(given));
    } catch {
      jwk = undefined;
    }
    if (jwk === undefined)
      throw new KeyError("KEEL_AGENT_KEY is not an Ed25519 private key as a JWK");
    const agentId = env["KEEL_AGENT_ID"];
    return {
      signer: await signerFromJwk(jwk),
      ...(agentId === undefined || agentId === "" ? {} : { agentId }),
      where: "KEEL_AGENT_KEY",
    };
  }
  const secret = await store?.read(entry);
  if (store === undefined || secret === undefined) return undefined;
  const held = decodeEntry(secret);
  if (held === undefined)
    throw new KeyError(`${store.kind} holds something under ${entry} that is not an agent's key`);
  return {
    signer: await signerFromJwk(held.jwk),
    ...(held.agentId === undefined ? {} : { agentId: held.agentId }),
    ...(held.handle === undefined ? {} : { handle: held.handle }),
    where: store.kind,
    stored: held.jwk,
  };
}
