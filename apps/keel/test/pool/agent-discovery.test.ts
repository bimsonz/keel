import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  freshAddress,
  granted,
  ISSUER,
  newKey,
  requestToken,
  seedKeyAgent,
  TOKEN_ENDPOINT,
} from "./agent-keys.ts";
import { BASE, worker } from "./helpers.ts";

/** Where RFC 8414 puts the document of an issuer with a path, and where a client that ignores the path looks. */
const AUTHORIZATION_SERVER = [
  "/.well-known/oauth-authorization-server/v1/auth",
  "/.well-known/oauth-authorization-server",
] as const;

const document = async (path: string) => {
  const response = await worker(`${BASE}${path}`);
  expect([path, response.status]).toEqual([path, 200]);
  return response.json<Record<string, unknown>>();
};

/** Every route of Keel's own a document names, by the field that names it. The issuer is a name, not a route. */
const ownUrls = (body: Record<string, unknown>): [string, string][] =>
  Object.entries(body).flatMap(([field, value]) =>
    field !== "issuer" && typeof value === "string" && value.startsWith(`${BASE}/`)
      ? [[field, value]]
      : [],
  );

/** Whether Keel serves anything at `url`: a route that refuses a bare request is still there. */
const answers = async (url: string): Promise<boolean> => {
  for (const method of ["GET", "POST"] as const) {
    const response = await worker(url, {
      method,
      headers: {
        "cf-connecting-ip": freshAddress(),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    if (response.status !== 404 && response.status !== 405) return true;
  }
  return false;
};

/** A token request as a client with no signed request sends it: its status, its OAuth error, and whether it was given a token. */
const asked = async (form: Record<string, string>, headers: Record<string, string> = {}) => {
  const response = await worker(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": freshAddress(),
      ...headers,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", ...form }),
  });
  const body = await response.json<Record<string, unknown>>();
  return [response.status, body["error"], "access_token" in body];
};

describe("what an arriving agent reads to find its way in", () => {
  it("[wellknown.documents] the authorization server's document names the issuer of Keel's tokens, where to sign up and where to ask for one", async () => {
    for (const path of AUTHORIZATION_SERVER) {
      const body = await document(path);
      expect(body).toMatchObject({
        issuer: ISSUER,
        token_endpoint: TOKEN_ENDPOINT,
        jwks_uri: `${ISSUER}/jwks`,
        registration_endpoint: `${BASE}/v1/oauth/register`,
        grant_types_supported: ["client_credentials"],
      });
      expect(body["token_endpoint_auth_methods_supported"]).toContain("private_key_jwt");
      expect(body["dpop_signing_alg_values_supported"]).toEqual(
        expect.arrayContaining(["EdDSA", "ES256"]),
      );
    }
  });

  it("[wellknown.takes] the authorization server's document says what Keel takes and nothing more: these fields and no other, one way for a client to name itself, and the two algorithms a key signs with", async () => {
    for (const path of AUTHORIZATION_SERVER)
      expect(await document(path)).toEqual({
        issuer: ISSUER,
        token_endpoint: TOKEN_ENDPOINT,
        jwks_uri: `${ISSUER}/jwks`,
        scopes_supported: ["agent:work", "agent:read"],
        response_types_supported: [],
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
        token_endpoint_auth_signing_alg_values_supported: ["EdDSA", "ES256"],
        dpop_signing_alg_values_supported: ["EdDSA", "ES256"],
        registration_endpoint: `${BASE}/v1/oauth/register`,
        service_documentation: `${BASE}/start`,
      });
  });

  it("[wellknown.refuses] the ways of naming a client that the document leaves out are refused by the endpoint it names: a secret in the form, a secret in a Basic header and no authentication at all get no token, where a request the agent's key signed gets one", async () => {
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    const secret = "a-secret-no-agent-was-ever-given";
    expect({
      post: await asked({ client_id: agent.id, client_secret: secret }),
      basic: await asked({}, { authorization: `Basic ${btoa(`${agent.id}:${secret}`)}` }),
      none: await asked({ client_id: agent.id }),
    }).toEqual({
      post: [400, "invalid_client", false],
      basic: [401, "invalid_client", false],
      none: [400, "invalid_client", false],
    });
    expect((await granted(await requestToken(agent.id, account))).token_type).toBe("Bearer");
  });

  it("[wellknown.documents] every route of Keel's the document names is one Keel serves", async () => {
    const body = await document(AUTHORIZATION_SERVER[0]);
    const dead: string[] = [];
    for (const [field, url] of ownUrls(body)) if (!(await answers(url))) dead.push(field);
    expect(dead).toEqual([]);
    expect(ownUrls(body).map(([field]) => field)).toEqual(
      expect.arrayContaining(["token_endpoint", "jwks_uri", "registration_endpoint"]),
    );
  });

  it("[wellknown.documents] the resource's document names Keel's API, and its MCP endpoint, with the server that issues their tokens", async () => {
    for (const [path, resource] of [
      ["/.well-known/oauth-protected-resource", BASE],
      ["/.well-known/oauth-protected-resource/mcp", `${BASE}/mcp`],
    ] as const) {
      const body = await document(path);
      expect(body).toMatchObject({
        resource,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ["header"],
      });
      expect(body["scopes_supported"]).toEqual(
        expect.arrayContaining(["agent:work", "agent:read"]),
      );
      expect(body["dpop_signing_alg_values_supported"]).toEqual(
        expect.arrayContaining(["EdDSA", "ES256"]),
      );
    }
  });

  it("[wellknown.documents] a token verifies against the published key and the document's issuer alone, and no private key is published", async () => {
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    const { access_token: token } = await granted(
      await requestToken(agent.id, account, { runKey: await newKey() }),
    );
    const body = await document(AUTHORIZATION_SERVER[0]);
    const published = await (await worker(String(body["jwks_uri"]))).json<JSONWebKeySet>();
    expect(published.keys.length).toBeGreaterThan(0);
    for (const key of published.keys) expect(Object.keys(key)).not.toContain("d");
    const verified = await jwtVerify(token, createLocalJWKSet(published), {
      issuer: String(body["issuer"]),
      audience: BASE,
    });
    expect(verified.payload.sub).toBe(agent.id);
  });
});
