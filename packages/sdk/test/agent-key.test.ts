import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
} from "jose";
import { describe, expect, it } from "vitest";
import {
  type AgentSigner,
  clientAssertion,
  discover,
  dpopProof,
  generateAgentKey,
  KeelTokenError,
  runKey,
  signerFromJwk,
  signUp,
  thumbprint,
} from "../src/index.ts";

/** The proof or signed request, checked by a library that is not the SDK's own code. */
const verified = async (jwt: string, signer: AgentSigner, typ: string) =>
  jwtVerify(jwt, await importJWK({ ...signer.publicJwk }, signer.alg), { typ });

const sha256 = async (text: string): Promise<string> =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** A P-256 key a hardware store might hold: the SDK sees only its public half and a way to sign. */
async function hardwareKey(): Promise<AgentSigner> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const { x = "", y = "" } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    alg: "ES256",
    publicJwk: { kty: "EC", crv: "P-256", x, y },
    sign: async (data) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new Uint8Array(data),
        ),
      ),
  };
}

describe("an agent's key in the SDK", () => {
  it("[sdk.key-generate] a new key is Ed25519, its public half names no private part, and the private JWK handed back once signs as the same key", async () => {
    const { signer, privateJwk } = await generateAgentKey();
    expect(signer.alg).toBe("EdDSA");
    expect(Object.keys(signer.publicJwk).toSorted()).toEqual(["crv", "kty", "x"]);
    expect(privateJwk).toMatchObject({ kty: "OKP", crv: "Ed25519", x: signer.publicJwk.x });
    expect(typeof privateJwk.d).toBe("string");
    const again = await signerFromJwk(privateJwk);
    expect(again.publicJwk).toEqual(signer.publicJwk);
    await verified(
      await dpopProof(again, { method: "GET", url: "https://keel.test/" }),
      signer,
      "dpop+jwt",
    );
    const other = await generateAgentKey();
    expect(other.signer.publicJwk.x).not.toBe(signer.publicJwk.x);
  });

  it("[sdk.key-generate] a run's key is new each time, and what is no Ed25519 private key is refused", async () => {
    const [first, second] = [await runKey(), await runKey()];
    expect(first.publicJwk.x).not.toBe(second.publicJwk.x);
    expect(Object.keys(first.publicJwk).toSorted()).toEqual(["crv", "kty", "x"]);
    const { privateKey: rsa } = await generateKeyPair("RS256", { extractable: true });
    const { signer } = await generateAgentKey();
    for (const notAKey of [await exportJWK(rsa), signer.publicJwk, "a string", null, {}])
      await expect(signerFromJwk(notAKey)).rejects.toThrow(/Ed25519 private key/);
  });

  it("[sdk.key-thumbprint] a key's thumbprint is RFC 7638's: RFC 8037's own Ed25519 example, and what jose computes for any key", async () => {
    expect(
      await thumbprint({
        kty: "OKP",
        crv: "Ed25519",
        x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      }),
    ).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    for (const signer of [(await generateAgentKey()).signer, await hardwareKey()])
      expect(await thumbprint(signer.publicJwk)).toBe(
        await calculateJwkThumbprint({ ...signer.publicJwk }),
      );
  });

  it("[sdk.key-proof] a proof is made by its own header's key for one method and URL, without the query, names the token it goes with, and is never the same twice", async () => {
    for (const signer of [(await generateAgentKey()).signer, await hardwareKey()]) {
      const request = { method: "post", url: "https://keel.test/v1/changes?wait=5#top" };
      const proof = await dpopProof(signer, { ...request, accessToken: "token-1" });
      const header = decodeProtectedHeader(proof);
      expect(header).toMatchObject({ typ: "dpop+jwt", alg: signer.alg, jwk: signer.publicJwk });
      expect(Object.keys(header.jwk ?? {})).not.toContain("d");
      const { payload } = await verified(proof, signer, "dpop+jwt");
      expect(payload).toMatchObject({
        htm: "POST",
        htu: "https://keel.test/v1/changes",
        ath: await sha256("token-1"),
      });
      expect(Math.abs((payload.iat ?? 0) - Date.now() / 1000)).toBeLessThan(5);
      const second = decodeJwt(await dpopProof(signer, { ...request, accessToken: "token-1" }));
      expect(second.jti).not.toBe(payload.jti);
      expect(String(payload.jti).length).toBeGreaterThanOrEqual(16);
      expect("ath" in decodeJwt(await dpopProof(signer, request))).toBe(false);
    }
  });

  it("[sdk.key-assertion] a signed token request is the agent speaking as itself to one issuer, naming the key that signed it, good for a minute, with an id of its own", async () => {
    const { signer } = await generateAgentKey();
    const asked = {
      agentId: "agt_0123456789ABCDEFGHJKMNPQRS",
      audience: "https://keel.test/v1/auth",
    };
    const assertion = await clientAssertion(signer, asked);
    const { payload, protectedHeader } = await verified(
      assertion,
      signer,
      "client-authentication+jwt",
    );
    expect(protectedHeader.jwk).toBeUndefined();
    // The key is named by its thumbprint: an agent with more than one key must say which signed.
    expect(protectedHeader.kid).toBe(await calculateJwkThumbprint({ ...signer.publicJwk }));
    expect(payload).toMatchObject({ iss: asked.agentId, sub: asked.agentId, aud: asked.audience });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
    expect(Math.abs((payload.iat ?? 0) - Date.now() / 1000)).toBeLessThan(5);
    expect(decodeJwt(await clientAssertion(signer, asked)).jti).not.toBe(payload.jti);
  });
});

const DOCUMENT = {
  issuer: "https://keel.test/v1/auth",
  token_endpoint: "https://keel.test/v1/auth/oauth2/token",
  registration_endpoint: "https://keel.test/v1/oauth/register",
  jwks_uri: "https://keel.test/v1/auth/jwks",
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

/** The JSON a request sent. */
const bodyOf = (sent: Sent | undefined): unknown =>
  JSON.parse(typeof sent?.init.body === "string" ? sent.init.body : "null");

/** A Keel that serves `document` at the well-known path and `answer` everywhere else. */
function keelServing(document: unknown, answer: () => Response = () => Response.json({})) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, init });
    return url === "https://keel.test/.well-known/oauth-authorization-server"
      ? Response.json(document)
      : answer();
  };
  return { fetch, sent };
}

describe("how the SDK finds its way in and signs an agent up", () => {
  it("[sdk.key-discovery] where to sign up and ask for a token is read from the origin's document, whatever path the base URL ends in", async () => {
    const keel = keelServing(DOCUMENT);
    expect(await discover("https://keel.test/", keel.fetch)).toEqual({
      issuer: DOCUMENT.issuer,
      tokenEndpoint: DOCUMENT.token_endpoint,
      signUpEndpoint: DOCUMENT.registration_endpoint,
    });
    expect(keel.sent.map((s) => [s.url, s.init.method ?? "GET"])).toEqual([
      ["https://keel.test/.well-known/oauth-authorization-server", "GET"],
    ]);
  });

  it("[sdk.key-discovery] a document that sends the agent's signed requests to another origin, or names no endpoint, is refused", async () => {
    const elsewhere = "https://elsewhere.example/v1/auth/oauth2/token";
    const documents: Record<string, unknown> = {
      "a token endpoint elsewhere": { ...DOCUMENT, token_endpoint: elsewhere },
      "a sign-up elsewhere": { ...DOCUMENT, registration_endpoint: elsewhere },
      "an issuer elsewhere": { ...DOCUMENT, issuer: "https://elsewhere.example/v1/auth" },
      "plain http": {
        ...DOCUMENT,
        token_endpoint: DOCUMENT.token_endpoint.replace("https", "http"),
      },
      "no token endpoint": { ...DOCUMENT, token_endpoint: undefined },
      "not a document": "<html>",
    };
    for (const [what, document] of Object.entries(documents))
      await expect(
        discover("https://keel.test", keelServing(document).fetch).then(() => what),
      ).rejects.toBeInstanceOf(KeelTokenError);
    await expect(
      discover("https://keel.test", async () => new Response("not found", { status: 404 })),
    ).rejects.toBeInstanceOf(KeelTokenError);
  });

  it("[sdk.key-signup] sign-up sends the public key and a proof that key made for that request, and answers the account it made or found", async () => {
    const { signer } = await generateAgentKey();
    const registered = {
      client_id: "agt_0123456789ABCDEFGHJKMNPQRS",
      handle: "agent-0123456789abcdef",
    };
    for (const [status, created] of [
      [201, true],
      [200, false],
    ] as const) {
      const keel = keelServing(DOCUMENT, () => Response.json(registered, { status }));
      expect(
        await signUp({ baseUrl: "https://keel.test", signer, name: "builder", fetch: keel.fetch }),
      ).toEqual({ agentId: registered.client_id, handle: registered.handle, created });
      const [, request] = keel.sent;
      expect([request?.url, request?.init.method]).toEqual([
        DOCUMENT.registration_endpoint,
        "POST",
      ]);
      const body = bodyOf(request);
      expect(body).toEqual({
        jwks: { keys: [signer.publicJwk] },
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["client_credentials"],
        client_name: "builder",
      });
      const headers = new Headers(request?.init.headers);
      expect(headers.get("content-type")).toBe("application/json");
      const { payload } = await verified(headers.get("dpop") ?? "", signer, "dpop+jwt");
      expect(payload).toMatchObject({ htm: "POST", htu: DOCUMENT.registration_endpoint });
    }
  });

  it("[sdk.key-signup] a refused sign-up throws Keel's own code and words, and an answer that names no account is no sign-up", async () => {
    const { signer } = await generateAgentKey();
    const refused = keelServing(DOCUMENT, () =>
      Response.json(
        { error: "invalid_dpop_proof", error_description: "The proof must be made now." },
        { status: 401 },
      ),
    );
    const failure = await signUp({
      baseUrl: "https://keel.test",
      signer,
      fetch: refused.fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KeelTokenError);
    expect(failure).toMatchObject({
      error: "invalid_dpop_proof",
      status: 401,
      description: "The proof must be made now.",
    });
    const empty = keelServing(DOCUMENT, () => Response.json({}, { status: 201 }));
    await expect(
      signUp({ baseUrl: "https://keel.test", signer, fetch: empty.fetch }),
    ).rejects.toBeInstanceOf(KeelTokenError);
    const body = bodyOf(refused.sent[1]);
    expect(body).toEqual({
      jwks: { keys: [signer.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    });
  });
});
