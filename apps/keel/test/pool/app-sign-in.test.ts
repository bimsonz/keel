// A person signing in through an app, as an MCP client does it, on the deployed
// fetch handler: the app registers at Keel's registration route as a public
// client, the person's browser is sent through the authorization endpoint to the
// consent page and allows it on a fresh passkey, the app trades the code for a
// token with its PKCE verifier, and the token acts as the person at the MCP
// server and nowhere else, until the person withdraws the consent.
import { describe, expect, it } from "vitest";
import { PERSON_INSTRUCTIONS } from "../../src/adapters/driving/mcp/server.ts";
import { BASE, mcp, mcpResult, seedUser, uniqueHandle, worker } from "./helpers.ts";

const MCP = `${BASE}/mcp`;
const AUTH = `${BASE}/v1/auth`;
const CALLBACK = "http://localhost:33418/callback";

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** A PKCE pair (RFC 7636): the verifier the app keeps, and the S256 challenge it sends. */
async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

/** The app's registration, as an MCP client sends it: its callback, a name, and the scopes it read. */
const register = (body: Record<string, unknown>) =>
  worker(`${BASE}/v1/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
    body: JSON.stringify(body),
  });

/** A request of the person's browser, signed in by its session. */
const asPerson = (
  session: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  worker(url, {
    redirect: "manual",
    ...init,
    headers: {
      authorization: `Bearer ${session}`,
      origin: BASE,
      "cf-connecting-ip": crypto.randomUUID(),
      ...init.headers,
    },
  });

const token = (form: Record<string, string>) =>
  worker(`${AUTH}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

/** An MCP tool's answer, or whether the door refused the token outright. */
async function tool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const response = await mcp(accessToken, "tools/call", { name, arguments: args }, name);
  if (response.status !== 200) return { status: response.status };
  const result = await mcpResult(response);
  return { status: 200, isError: result["isError"] === true };
}

/** Registers an app, and has a person allow it: the code at its callback, and what the app keeps. */
async function signedInThrough(session: string) {
  const registered = await register({
    redirect_uris: [CALLBACK],
    client_name: "An MCP client",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // What a client reads from the resource's document: an agent's scopes too, which Keel does not grant.
    scope: "agent:work agent:read person",
    logo_uri: "https://example.com/logo.png",
  });
  expect(registered.status).toBe(201);
  const app = await registered.json<Record<string, unknown>>();
  expect(app).toMatchObject({ kind: "app", scope: "person offline_access" });
  const clientId = String(app["client_id"]);
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    scope: "agent:work agent:read",
    resource: MCP,
  });
  const authorized = await asPerson(session, `${AUTH}/oauth2/authorize?${query.toString()}`);
  expect(authorized.status).toBe(302);
  const consent = new URL(authorized.headers.get("location") ?? "");
  expect(`${consent.origin}${consent.pathname}`).toBe(`${BASE}/consent`);
  expect(consent.searchParams.get("scope")).toBe("person offline_access");
  return { clientId, verifier, consent };
}

describe("a person signing in through an app at Keel's MCP server", () => {
  it("[app.sign-in] an app registers as a public client, its person allows it on a fresh passkey, and its token acts as the person at the MCP server: listing the questions put to them, while Keel's API refuses it; a refresh gives another", async () => {
    const person = await seedUser(uniqueHandle("allower"), { signedInBy: "passkey" });
    const { clientId, verifier, consent } = await signedInThrough(person.token);

    const allowed = await asPerson(person.token, `${AUTH}/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
    });
    expect(allowed.status).toBe(200);
    const back = new URL(String((await allowed.json<Record<string, unknown>>())["url"]));
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("state-1");
    const code = back.searchParams.get("code") ?? "";

    const traded = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    });
    expect(traded.status).toBe(200);
    const tokens = await traded.json<Record<string, unknown>>();
    expect(tokens).toMatchObject({ scope: "person offline_access" });
    const access = String(tokens["access_token"]);

    const discovered = await mcpResult(await mcp(access, "server/discover"));
    expect(discovered["instructions"]).toBe(PERSON_INSTRUCTIONS);
    expect(await tool(access, "Operator_listEscalations", { state: "open" })).toEqual({
      status: 200,
      isError: false,
    });
    // The same token at Keel's API is no token at all.
    const api = await worker(`${BASE}/v1/users/me`, {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(api.status).toBe(401);

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: String(tokens["refresh_token"]),
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const again = String((await refreshed.json<Record<string, unknown>>())["access_token"]);
    expect(await tool(again, "Operator_listEscalations", { state: "open" })).toMatchObject({
      status: 200,
    });
  });

  it("[app.withdrawn] once the person withdraws their consent the app's token is refused at the MCP server at once, and its refresh gives it nothing", async () => {
    const person = await seedUser(uniqueHandle("withdrawer"), { signedInBy: "passkey" });
    const { clientId, verifier, consent } = await signedInThrough(person.token);
    const allowed = await asPerson(person.token, `${AUTH}/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
    });
    const back = new URL(String((await allowed.json<Record<string, unknown>>())["url"]));
    const tokens = await (
      await token({
        grant_type: "authorization_code",
        code: back.searchParams.get("code") ?? "",
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CALLBACK,
      })
    ).json<Record<string, unknown>>();
    const access = String(tokens["access_token"]);
    expect(await tool(access, "Operator_listEscalations")).toMatchObject({ status: 200 });

    const listed = await asPerson(person.token, `${AUTH}/oauth2/get-consents`);
    expect(listed.status).toBe(200);
    const consents = await listed.json<readonly Record<string, unknown>[]>();
    const mine = consents.find((row) => row["clientId"] === clientId);
    expect(mine).toBeDefined();
    const withdrawn = await asPerson(person.token, `${AUTH}/oauth2/delete-consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: mine?.["id"] }),
    });
    expect(withdrawn.status).toBe(200);

    expect(await tool(access, "Operator_listEscalations")).toEqual({ status: 401 });
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: String(tokens["refresh_token"]),
      client_id: clientId,
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
  });

  it("[app.fresh] allowing an app needs a passkey sign-in from the last ten minutes: an older session is refused and the app is given no code", async () => {
    const person = await seedUser(uniqueHandle("stale"), { signedInBy: "email-otp" });
    const { consent } = await signedInThrough(person.token);
    const allowed = await asPerson(person.token, `${AUTH}/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
    });
    expect(allowed.status).toBe(403);
    expect(await allowed.json()).toMatchObject({ code: "FRESH_SIGN_IN_REQUIRED" });
  });

  it("[app.callbacks] an app's callback is https to another machine, or http to this one: any other is refused, and so is a request for another of Keel's resources", async () => {
    for (const uri of [
      "http://example.com/callback",
      "https://example.com/callback#fragment",
      "https://localhost/callback",
      "ftp://localhost/callback",
    ]) {
      const refused = await register({ redirect_uris: [uri] });
      const said = await refused.json<Record<string, unknown>>();
      expect([uri, refused.status, said["error"]]).toEqual([uri, 400, "invalid_redirect_uri"]);
      // Keel's own rule refused it, before the provider was asked.
      expect(said["error_description"]).toBe(
        `${uri} is no callback Keel sends a code to: it takes https to another machine, or http to this one (localhost, 127.0.0.1 or [::1]), with no fragment.`,
      );
    }
    for (const uri of ["http://127.0.0.1:9/cb", "https://claude.ai/api/mcp/auth_callback"]) {
      const made = await register({ redirect_uris: [uri] });
      expect([uri, made.status]).toEqual([uri, 201]);
      await made.body?.cancel();
    }

    const person = await seedUser(uniqueHandle("target"), { signedInBy: "passkey" });
    const registered = await (
      await register({ redirect_uris: [CALLBACK] })
    ).json<Record<string, unknown>>();
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: String(registered["client_id"]),
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: BASE,
    });
    const elsewhere = await asPerson(person.token, `${AUTH}/oauth2/authorize?${query.toString()}`);
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.json()).toMatchObject({ error: "invalid_target" });
  });
});
