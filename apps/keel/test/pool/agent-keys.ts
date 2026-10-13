import { env, exports } from "cloudflare:workers";
import { type Agent, type AgentKey, KeyThumbprint } from "@keeltown/core/domain/identity";
import { Instant } from "@keeltown/core/kernel";
import { AgentDirectory } from "@keeltown/core/ports";
import { signedUpAgent } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { BASE } from "./helpers.ts";

/** Who issues an agent's tokens: Better Auth, where Keel mounts it. */
export const ISSUER = `${BASE}/v1/auth`;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** A key pair as an agent holds one: the private half never leaves the test. */
export interface TestKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly key: AgentKey;
}

/** A new key pair. `extractable` lets a test read the private half, to send what an agent never should. */
export async function newKey(options: { readonly extractable?: boolean } = {}): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: options.extractable ?? false,
  });
  const publicJwk = await exportJWK(publicKey);
  const jkt = Schema.decodeUnknownSync(KeyThumbprint)(await calculateJwkThumbprint(publicJwk));
  const jwk = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.NonEmptyString }))(publicJwk);
  return {
    privateKey,
    publicJwk,
    key: {
      jkt,
      jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      addedAt: Instant(Date.UTC(2026, 9, 13)),
    },
  };
}

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

export interface ProofOptions {
  /** The access token the proof is for, on a request that presents one. */
  readonly accessToken?: string;
  /** When the proof says it was made, in seconds; now when absent. */
  readonly issuedAt?: number;
  readonly jti?: string;
}

/** A DPoP proof (RFC 9449) for one request, made by `key`. */
export async function proofBy(
  key: TestKey,
  method: string,
  url: string,
  options: ProofOptions = {},
): Promise<string> {
  return new SignJWT({
    htm: method,
    htu: url,
    jti: options.jti ?? crypto.randomUUID(),
    ...(options.accessToken === undefined ? {} : { ath: await sha256(options.accessToken) }),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk: key.publicJwk })
    .setIssuedAt(options.issuedAt)
    .sign(key.privateKey);
}

export interface AssertionOptions {
  readonly audience?: string;
  /** How long the assertion says it lasts, in seconds. */
  readonly lifetime?: number;
}

/** A client assertion (RFC 7523): the agent asking for a token as itself, signed by `key`. */
export async function assertionBy(
  key: TestKey,
  agentId: string,
  options: AssertionOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "client-authentication+jwt" })
    .setIssuer(agentId)
    .setSubject(agentId)
    .setAudience(options.audience ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.lifetime ?? 60))
    .setJti(crypto.randomUUID())
    .sign(key.privateKey);
}

/** An address no other request in the run comes from (TEST-NET-3 and beyond, never routed). */
export const freshAddress = (): string =>
  `203.0.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}-${crypto.randomUUID().slice(0, 8)}`;

/** An agent as signing up with `account` leaves it in the directory. */
export async function seedKeyAgent(
  account: TestKey,
  overrides: Partial<Agent> = {},
): Promise<Agent> {
  const agent: Agent = { ...signedUpAgent([account.key]), ...overrides };
  await Effect.runPromise(
    AgentDirectory.use((directory) => directory.upsertAccount(agent)).pipe(
      Effect.provide(AgentDirectoryD1(env.DB)),
    ),
  );
  return agent;
}

export interface TokenRequest {
  /** The key the token is to be bound to; none asks for a plain bearer. */
  readonly runKey?: TestKey;
  readonly project?: string;
  readonly run?: string;
  readonly scope?: string;
  /** An assertion to send instead of a fresh one signed by the account key. */
  readonly assertion?: string;
  /** A proof to send instead of a fresh one made by the run key. */
  readonly proof?: string;
  /** The resource the token is for (RFC 8707): Keel's own when absent, none when null. */
  readonly resource?: string | null;
  /** The address the request comes from; one of its own when absent. */
  readonly from?: string;
}

/** Asks Keel's token endpoint for a token as `agentId`, the way an agent holding `account` does. */
export async function requestToken(
  agentId: string,
  account: TestKey,
  request: TokenRequest = {},
): Promise<Response> {
  const proof =
    request.proof ??
    (request.runKey === undefined
      ? undefined
      : await proofBy(request.runKey, "POST", TOKEN_ENDPOINT));
  return exports.default.fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Each request from an address of its own, so the per-address limit never decides a case that is not about it.
      "cf-connecting-ip": request.from ?? freshAddress(),
      ...(proof === undefined ? {} : { dpop: proof }),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: request.assertion ?? (await assertionBy(account, agentId)),
      ...(request.resource === null ? {} : { resource: request.resource ?? BASE }),
      ...(request.project === undefined ? {} : { project: request.project }),
      ...(request.run === undefined ? {} : { run: request.run }),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
    }),
  });
}

export interface Granted {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope: string;
}

/** The token a request was granted; a refusal fails the test with its OAuth error, never the token. */
export async function granted(response: Response): Promise<Granted> {
  if (response.status !== 200)
    throw new Error(`the token request answered ${response.status}: ${await response.text()}`);
  return response.json<Granted>();
}
