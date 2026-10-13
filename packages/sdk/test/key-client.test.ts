import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentSigner,
  createKeelClient,
  generateAgentKey,
  type KeyClientOptions,
  KeelTokenError,
  thumbprint,
} from "../src/index.ts";

const ORIGIN = "https://keel.test";
const ISSUER = `${ORIGIN}/v1/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const AGENT = "agt_0123456789ABCDEFGHJKMNPQRS";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

/**
 * A fake Keel for an agent that holds a key: it serves the discovery document,
 * answers each token request with `token-<n>` (a `DPoP` one when the request
 * carries a proof), and whatever `respond` scripts for the rest.
 */
async function keyKeel(
  options: Partial<KeyClientOptions> = {},
  respond: (request: Sent, call: number) => Response = () => Response.json({ ok: true }),
  tokenAnswer?: () => Response,
) {
  const { signer } = await generateAgentKey();
  const sent: Sent[] = [];
  let calls = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Sent = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    sent.push(request);
    if (url === `${ORIGIN}/.well-known/oauth-authorization-server`)
      return Response.json({
        issuer: ISSUER,
        token_endpoint: TOKEN_ENDPOINT,
        registration_endpoint: `${ORIGIN}/v1/oauth/register`,
      });
    if (url === TOKEN_ENDPOINT) {
      if (tokenAnswer !== undefined) return tokenAnswer();
      const n = sent.filter((s) => s.url === TOKEN_ENDPOINT).length;
      return Response.json({
        access_token: `token-${n}`,
        token_type: request.headers.has("dpop") ? "DPoP" : "Bearer",
        expires_in: 300,
        scope: "agent:work agent:read",
      });
    }
    calls += 1;
    return respond(request, calls);
  };
  const client = createKeelClient({
    baseUrl: `${ORIGIN}/`,
    agentId: AGENT,
    key: signer,
    fetch,
    ...options,
  });
  const to = (url: string) => sent.filter((s) => s.url === url);
  return {
    client,
    signer,
    sent,
    tokenRequests: () => to(TOKEN_ENDPOINT),
    discoveries: () => to(`${ORIGIN}/.well-known/oauth-authorization-server`),
    calls: () => sent.filter((s) => s.url.startsWith(`${ORIGIN}/v1/`) && s.url !== TOKEN_ENDPOINT),
  };
}

/** The key that made a proof, by thumbprint, once the proof verifies under it. */
async function proofOf(proof: string | null) {
  const header = decodeProtectedHeader(proof ?? "");
  const jwk = header.jwk ?? {};
  const { payload } = await jwtVerify(proof ?? "", await importJWK(jwk, header.alg), {
    typ: "dpop+jwt",
  });
  return { payload, jkt: await calculateJwkThumbprint(jwk) };
}

const assertedBy = async (assertion: string | null, signer: AgentSigner) =>
  (
    await jwtVerify(assertion ?? "", await importJWK({ ...signer.publicJwk }, signer.alg), {
      typ: "client-authentication+jwt",
    })
  ).payload;

const sha256 = async (text: string): Promise<string> =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const unauthorized = () =>
  new Response(
    JSON.stringify({
      type: "urn:keel:problem:auth.invalid_token",
      title: "auth.invalid_token",
      status: 401,
      code: "auth.invalid_token",
      requestId: "req-1",
      nextActions: [],
    }),
    { status: 401, headers: { "content-type": "application/problem+json" } },
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("the Keel client for an agent that holds a key", () => {
  it("[sdk.key-resource] a client made for one of Keel's doors asks for that door's token by name, and a client made for none names none", async () => {
    const door = await keyKeel({ resource: `${ORIGIN}/mcp` });
    await door.client.token();
    const [asked] = door.tokenRequests();
    expect(new URLSearchParams(asked?.body).get("resource")).toBe(`${ORIGIN}/mcp`);
    const api = await keyKeel();
    await api.client.token();
    expect(api.tokenRequests()).toHaveLength(1);
    expect(new URLSearchParams(api.tokenRequests()[0]?.body).has("resource")).toBe(false);
  });

  it("[sdk.key-token] asks the discovered endpoint with a request the account key signed, for one project and one run, bound to a run key that is never the account key", async () => {
    const keel = await keyKeel({ project: "prj_0123456789ABCDEFGHJKMNPQRS", run: "run-c" });
    await keel.client.whoami();
    await keel.client.whoami();
    expect(keel.discoveries()).toHaveLength(1);
    expect(keel.tokenRequests()).toHaveLength(1);
    const [request] = keel.tokenRequests();
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(request?.body);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      project: "prj_0123456789ABCDEFGHJKMNPQRS",
      run: "run-c",
    });
    expect([form.has("client_id"), form.has("client_secret"), form.has("scope")]).toEqual([
      false,
      false,
      false,
    ]);
    expect(await assertedBy(form.get("client_assertion"), keel.signer)).toMatchObject({
      iss: AGENT,
      sub: AGENT,
      aud: ISSUER,
    });
    const proof = await proofOf(request?.headers.get("dpop") ?? null);
    expect(proof.payload).toMatchObject({ htm: "POST", htu: TOKEN_ENDPOINT });
    expect("ath" in proof.payload).toBe(false);
    expect(proof.jkt).not.toBe(await thumbprint(keel.signer.publicJwk));
  });

  it("[sdk.key-token] a token is kept until half a minute before it lapses, and a 401 gets one new token and one retry under the same run key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const keel = await keyKeel({}, (_request, call) =>
      call === 3 ? unauthorized() : Response.json({ ok: true }),
    );
    await keel.client.whoami();
    vi.setSystemTime(Date.now() + 260_000);
    await keel.client.whoami();
    expect(keel.tokenRequests()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 15_000);
    await keel.client.whoami();
    expect(keel.tokenRequests()).toHaveLength(3);
    expect(keel.calls().map((s) => s.headers.get("authorization"))).toEqual([
      "DPoP token-1",
      "DPoP token-1",
      "DPoP token-2",
      "DPoP token-3",
    ]);
    const keys = await Promise.all(
      [...keel.tokenRequests(), ...keel.calls()].map(
        async (s) => (await proofOf(s.headers.get("dpop"))).jkt,
      ),
    );
    expect(new Set(keys).size).toBe(1);
    const form = new URLSearchParams(keel.tokenRequests()[0]?.body);
    expect([form.has("project"), form.has("run")]).toEqual([false, false]);
  });

  it("[sdk.key-call] every call presents its token under the DPoP scheme with a new proof by the run key for that method, that URL without its query, and that token", async () => {
    const keel = await keyKeel();
    await keel.client.status("chg_1", { wait: 5 });
    await keel.client.status("chg_1", { wait: 5 });
    await keel.client.declare({ goal: "g", footprint: [], premises: [] });
    const [tokenRequest] = keel.tokenRequests();
    const runKey = (await proofOf(tokenRequest?.headers.get("dpop") ?? null)).jkt;
    const proofs = await Promise.all(
      keel.calls().map(async (s) => ({
        url: s.url,
        scheme: s.headers.get("authorization"),
        ...(await proofOf(s.headers.get("dpop"))),
      })),
    );
    expect(proofs.map((p) => [p.scheme, p.jkt, p.payload["htm"], p.payload["htu"]])).toEqual([
      ["DPoP token-1", runKey, "GET", `${ORIGIN}/v1/changes/chg_1/submission`],
      ["DPoP token-1", runKey, "GET", `${ORIGIN}/v1/changes/chg_1/submission`],
      ["DPoP token-1", runKey, "POST", `${ORIGIN}/v1/changes`],
    ]);
    expect(proofs[0]?.url).toBe(`${ORIGIN}/v1/changes/chg_1/submission?wait=5`);
    for (const proof of proofs) expect(proof.payload["ath"]).toBe(await sha256("token-1"));
    expect(new Set(proofs.map((p) => p.payload.jti)).size).toBe(3);
  });

  it("[sdk.key-bearer] a client asked for a plain token sends no proof with its request or its calls, and hands the token out for a tool that cannot sign", async () => {
    const keel = await keyKeel({ bound: false, run: "mcp", scopes: ["agent:read"] });
    expect(await keel.client.token()).toBe("token-1");
    await keel.client.whoami();
    const [request] = keel.tokenRequests();
    expect(keel.tokenRequests()).toHaveLength(1);
    expect(request?.headers.has("dpop")).toBe(false);
    expect(new URLSearchParams(request?.body).get("scope")).toBe("agent:read");
    expect(
      keel.calls().map((s) => [s.headers.get("authorization"), s.headers.has("dpop")]),
    ).toEqual([["Bearer token-1", false]]);
  });

  it("[sdk.key-refused] a refused token request throws Keel's code and words, and nothing is called with no token", async () => {
    const keel = await keyKeel({ project: "not-a-project" }, undefined, () =>
      Response.json(
        { error: "invalid_target", error_description: "`project` must be a project's id." },
        { status: 400 },
      ),
    );
    const failure = await keel.client.whoami().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KeelTokenError);
    expect(failure).toMatchObject({
      error: "invalid_target",
      status: 400,
      description: "`project` must be a project's id.",
    });
    expect(keel.calls()).toEqual([]);
    expect(
      decodeJwt(new URLSearchParams(keel.tokenRequests()[0]?.body).get("client_assertion") ?? "")
        .iss,
    ).toBe(AGENT);
  });
});
