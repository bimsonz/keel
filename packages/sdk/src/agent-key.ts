import { KeelTokenError } from "./problem.ts";

/**
 * An agent's key, and what it signs: its sign-up, each request for a
 * token (RFC 7523) and the proof that goes with a token bound to a key (DPoP,
 * RFC 9449). WebCrypto only, so it runs wherever the client does.
 */

/** A public key as a JWK: Ed25519, or P-256 for a key a hardware store holds. Public members only. */
export type PublicJwk =
  | { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string }
  | { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };

/** An Ed25519 key with its private part: what a key store holds, and nothing else ever should. */
export interface PrivateJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly d: string;
}

/**
 * A key that can sign, and its public half. The private half is never asked
 * for, so a key that cannot leave its store (a keychain, a hardware token)
 * is one of these as it stands. `sign` answers the signature as a JWS carries
 * it: 64 bytes for either algorithm.
 */
export interface AgentSigner {
  readonly publicJwk: PublicJwk;
  readonly alg: "EdDSA" | "ES256";
  readonly sign: (data: Uint8Array) => Promise<Uint8Array>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const ED25519 = { name: "Ed25519" } as const;
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const segment = (value: object): string => base64url(encoder.encode(JSON.stringify(value)));

async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** A key as WebCrypto holds one, named from the platform's own function so it reads the same under every lib. */
type PlatformKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** A new Ed25519 pair. `extractable` is whether the private half can ever be read back out. */
async function newPair(extractable: boolean) {
  const made = await crypto.subtle.generateKey(ED25519, extractable, ["sign", "verify"]);
  if (!("privateKey" in made)) throw new Error("the platform made no key pair");
  return made;
}

function ed25519Signer(privateKey: PlatformKey, x: string): AgentSigner {
  return {
    alg: "EdDSA",
    publicJwk: { kty: "OKP", crv: "Ed25519", x },
    sign: async (data) =>
      new Uint8Array(await crypto.subtle.sign(ED25519, privateKey, new Uint8Array(data))),
  };
}

const text = (value: unknown, name: string): string | undefined => {
  const member: unknown = Reflect.get(Object(value), name);
  return typeof member === "string" && member !== "" ? member : undefined;
};

/**
 * A new account key. The private JWK is handed back once, for the caller's key
 * store; the signer holds its own copy, which cannot be read back out.
 */
export async function generateAgentKey(): Promise<{
  readonly signer: AgentSigner;
  readonly privateJwk: PrivateJwk;
}> {
  const pair = await newPair(true);
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const x = text(exported, "x");
  const d = text(exported, "d");
  if (x === undefined || d === undefined) throw new Error("the platform made a key with no parts");
  const privateJwk: PrivateJwk = { kty: "OKP", crv: "Ed25519", x, d };
  return { signer: await signerFromJwk(privateJwk), privateJwk };
}

/** The signer for a private JWK read from a key store. The key is imported so that it cannot be exported again. */
export async function signerFromJwk(privateJwk: unknown): Promise<AgentSigner> {
  const x = text(privateJwk, "x");
  const d = text(privateJwk, "d");
  const refused = new Error(
    "This is not an Ed25519 private key as a JWK (kty OKP, crv Ed25519, x, d).",
  );
  if (
    text(privateJwk, "kty") !== "OKP" ||
    text(privateJwk, "crv") !== "Ed25519" ||
    x === undefined ||
    d === undefined
  )
    throw refused;
  let key: PlatformKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x, d },
      ED25519,
      false,
      ["sign"],
    );
  } catch {
    throw refused;
  }
  return ed25519Signer(key, x);
}

/**
 * A key for one run: made in memory, never stored, and unreadable even by the
 * process that holds it. A token is bound to one of these, never to the
 * account's own key.
 */
export async function runKey(): Promise<AgentSigner> {
  const pair = await newPair(false);
  const x = text(await crypto.subtle.exportKey("jwk", pair.publicKey), "x");
  if (x === undefined) throw new Error("the platform made a key with no public part");
  return ed25519Signer(pair.privateKey, x);
}

/** A key's thumbprint (RFC 7638): what Keel names the key by, and makes the agent's id from. */
export function thumbprint(jwk: PublicJwk): Promise<string> {
  // The required members, in the order of their names.
  return sha256(
    jwk.kty === "OKP"
      ? `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`
      : `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`,
  );
}

async function signed(signer: AgentSigner, header: object, payload: object): Promise<string> {
  const signing = `${segment({ alg: signer.alg, ...header })}.${segment(payload)}`;
  return `${signing}.${base64url(await signer.sign(encoder.encode(signing)))}`;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** What a proof is made for: one request, and the token it carries when it carries one. */
export interface ProofRequest {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}

/**
 * A DPoP proof (RFC 9449 §4.2): `signer` saying it is making this request now.
 * It names the method and the URL without its query or fragment, carries the
 * hash of the token it goes with, and has an id of its own, so it is good once.
 */
export async function dpopProof(signer: AgentSigner, request: ProofRequest): Promise<string> {
  const url = new URL(request.url);
  return signed(
    signer,
    { typ: "dpop+jwt", jwk: signer.publicJwk },
    {
      jti: crypto.randomUUID(),
      htm: request.method.toUpperCase(),
      htu: `${url.origin}${url.pathname}`,
      iat: now(),
      ...(request.accessToken === undefined ? {} : { ath: await sha256(request.accessToken) }),
    },
  );
}

/** How long a signed token request says it is good for: the most Keel takes. */
const ASSERTION_SECONDS = 60;

/**
 * A signed request for a token (RFC 7523 §3): the agent, as itself, to one
 * issuer. Good for a minute and, by its id, once. It names the key that signed
 * it by thumbprint, which is how Keel tells an agent's keys apart.
 */
export async function clientAssertion(
  signer: AgentSigner,
  asked: { readonly agentId: string; readonly audience: string },
): Promise<string> {
  const issuedAt = now();
  return signed(
    signer,
    { typ: "client-authentication+jwt", kid: await thumbprint(signer.publicJwk) },
    {
      iss: asked.agentId,
      sub: asked.agentId,
      aud: asked.audience,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_SECONDS,
      jti: crypto.randomUUID(),
    },
  );
}

/** Where an agent signs up and asks for tokens, as Keel's own document says. */
export interface Discovered {
  /** Who issues Keel's tokens: the audience of a signed token request. */
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly signUpEndpoint: string;
}

/** Keel's origin, from a base URL with or without a trailing slash. */
export const originOf = (baseUrl: string): string => new URL(baseUrl).origin;

const WELL_KNOWN = "/.well-known/oauth-authorization-server";

/**
 * Reads where to sign up and ask for a token from the document at the origin's
 * root (RFC 8414), so nothing but that path is written into a client. Every
 * place it names must be Keel's own origin over https: an agent's signed
 * request sent anywhere else could be spent there in its place.
 */
export async function discover(baseUrl: string, fetcher: Fetch = fetch): Promise<Discovered> {
  const origin = originOf(baseUrl);
  const refused = (why: string) =>
    new KeelTokenError("invalid_response", 0, `${origin}${WELL_KNOWN} ${why}`);
  const response = await fetcher(`${origin}${WELL_KNOWN}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw refused(`answered ${response.status}.`);
  const document: unknown = await response.json().catch(() => undefined);
  const named = {
    issuer: text(document, "issuer"),
    tokenEndpoint: text(document, "token_endpoint"),
    signUpEndpoint: text(document, "registration_endpoint"),
  };
  const { issuer, tokenEndpoint, signUpEndpoint } = named;
  if (issuer === undefined || tokenEndpoint === undefined || signUpEndpoint === undefined)
    throw refused("names no issuer, token endpoint or sign-up.");
  for (const place of [issuer, tokenEndpoint, signUpEndpoint])
    if (!URL.canParse(place) || new URL(place).origin !== origin || !place.startsWith("https:"))
      throw refused(`names ${place}, which is not ${origin} over https.`);
  return { issuer, tokenEndpoint, signUpEndpoint };
}

/** An OAuth refusal's code and words (RFC 6749 §5.2), from whatever the endpoint answered. */
export function refusalOf(status: number, body: unknown): KeelTokenError {
  return new KeelTokenError(
    text(body, "error") ?? text(body, "code") ?? "invalid_response",
    status,
    text(body, "error_description") ?? text(body, "detail"),
  );
}

export interface SignUpRequest {
  /** Keel's origin, e.g. `https://keel.town`. */
  readonly baseUrl: string;
  readonly signer: AgentSigner;
  /** What the agent calls itself: a label. Its handle is made from its key. */
  readonly name?: string;
  readonly fetch?: Fetch;
}

/** The account a sign-up made, or found already there: one key is one account. */
export interface SignedUp {
  readonly agentId: string;
  readonly handle: string;
  readonly created: boolean;
}

/**
 * Signs an agent up with its public key and a proof that key made for this
 * request (RFC 7591's shape). No person, no browser and no secret:
 * the key is the account, so signing up again with it answers the same agent.
 */
export async function signUp(request: SignUpRequest): Promise<SignedUp> {
  const fetcher = request.fetch ?? fetch;
  const { signUpEndpoint } = await discover(request.baseUrl, fetcher);
  const response = await fetcher(signUpEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      dpop: await dpopProof(request.signer, { method: "POST", url: signUpEndpoint }),
    },
    body: JSON.stringify({
      jwks: { keys: [request.signer.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
      ...(request.name === undefined ? {} : { client_name: request.name }),
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw refusalOf(response.status, body);
  const agentId = text(body, "client_id");
  const handle = text(body, "handle");
  if (agentId === undefined || handle === undefined)
    throw new KeelTokenError("invalid_response", response.status, "The sign-up named no account.");
  return { agentId, handle, created: response.status === 201 };
}
