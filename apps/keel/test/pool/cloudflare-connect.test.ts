// Connecting a project's deploy target to a Cloudflare account through Keel's
// OAuth client, through the real gate, policy, handlers, Project DO,
// credential store and adapters, on the app as the isolate composes it.
// Cloudflare is the one thing doubled: `fetch` is spied on in this isolate,
// every request to its consent host or its API is answered here and recorded,
// and anything else fails the test.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_API } from "../../src/adapters/driven/deploy/cloudflare-api.ts";
import {
  AUTHORIZE_URL,
  CLOUDFLARE_SCOPES,
  challengeOf,
  formEncode,
  TOKEN_URL,
  WORKERS_SCRIPTS_WRITE,
} from "../../src/adapters/driven/deploy/cloudflare-oauth.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  BASE,
  CLIENT_SECRET,
  drainAfter,
  establishProject,
  type Fetch,
  placeProject,
  POOL_ORG,
  seedUser,
  uniqueHandle,
} from "./helpers.ts";

const isolate = makeIsolate(env, isolateLayer(env));
/** The app as the isolate composes it, run in this isolate, so the spy on `fetch` is the one it calls. */
const app: Fetch = async (url, init) =>
  isolate.app.fetch(new Request(url, init), env, createExecutionContext());

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const GROUP = "c8fed203ed3043cba015a93ad1616f1f";

interface Answered {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
  readonly headers: Headers;
}

async function call(
  path: string,
  options: { readonly token?: string; readonly method?: string },
): Promise<Answered> {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  const response = await app(`${BASE}/v1${path}`, {
    method: options.method ?? "GET",
    headers,
    redirect: "manual",
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text === "" ? {} : JSON.parse(text),
    headers: response.headers,
  };
}

const drainProject = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

async function freshProject(): Promise<ProjectId> {
  const projectId = makeId("prj", ulid());
  await placeProject(projectId, POOL_ORG);
  await establishProject(projectId);
  drainProject(projectId);
  return projectId;
}

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string;
}

const envelope = (status: number, result: unknown, codes: readonly number[] = []) =>
  Response.json(
    { success: status < 300, errors: codes.map((code) => ({ code })), messages: [], result },
    { status },
  );

/** The access token Cloudflare's double hands out for a code, and the token it mints. */
const ACCESS = `oauth-access-${crypto.randomUUID()}`;
const MINTED = `cfat_minted-${crypto.randomUUID()}`;

/** Cloudflare doubled: its token endpoint and API, answering a consent of `accounts`. */
function cloudflare(accounts: readonly string[] = [ACCOUNT]) {
  const asked: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url !== TOKEN_URL && !request.url.startsWith(`${CLOUDFLARE_API}/`))
      throw new Error(`no fetch to ${request.url} was expected`);
    asked.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
    if (request.url === TOKEN_URL)
      return Response.json({ access_token: ACCESS, token_type: "bearer", expires_in: 3599 });
    const path = url.pathname.slice(new URL(CLOUDFLARE_API).pathname.length);
    if (path === "/accounts")
      return envelope(
        200,
        accounts.map((id) => ({ id, name: `account ${id.slice(0, 4)}` })),
      );
    if (path === `/accounts/${ACCOUNT}/tokens/permission_groups`)
      return envelope(200, [
        { id: GROUP, name: WORKERS_SCRIPTS_WRITE, scopes: ["com.cloudflare.api.account"] },
      ]);
    if (path === `/accounts/${ACCOUNT}/tokens` && request.method === "POST")
      return envelope(200, { id: "tok_1", name: "minted", status: "active", value: MINTED });
    if (path === `/accounts/${ACCOUNT}/workers/subdomain`)
      return envelope(200, { subdomain: "acme" });
    return envelope(404, null, [7003]);
  });
  return asked;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** An owner begins a Connect of `production`, and answers the consent URL. */
async function begin(token: string, projectId: ProjectId): Promise<URL> {
  const begun = await call(`/projects/${projectId}/deploy-targets/production/cloudflare-connect`, {
    token,
    method: "POST",
  });
  expect(begun.status).toBe(200);
  return new URL(String(begun.json["authorizeUrl"]));
}

const callback = (token: string | undefined, query: Record<string, string>) =>
  call(
    `/cloudflare/callback?${new URLSearchParams(query).toString()}`,
    token === undefined ? {} : { token },
  );

describe("connecting a Cloudflare account", () => {
  it("[connect.pool.flow] consent, then the code exchanged with its verifier, a Workers token minted on the one account, sealed, and the target set with it", async () => {
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const projectId = await freshProject();
    const asked = cloudflare();
    const consent = await begin(owner.token, projectId);
    expect(`${consent.origin}${consent.pathname}`).toBe(AUTHORIZE_URL);
    const query = consent.searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe("keel-test-client");
    expect(query.get("redirect_uri")).toBe(`https://${env.KEEL_HOST}/v1/cloudflare/callback`);
    expect(query.get("scope")?.split(" ")).toEqual([...CLOUDFLARE_SCOPES]);
    expect(query.get("code_challenge_method")).toBe("S256");
    const state = query.get("state") ?? "";
    expect(state).toMatch(new RegExp(`^${projectId}\\.[A-Za-z0-9_-]{43}$`));
    expect(asked).toEqual([]);

    const back = await callback(owner.token, { code: "the-code", state });
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toMatch(
      /^\/pool\/[^/?]+\/settings\?cloudflare=connected$/,
    );
    expect(back.headers.get("keel-cloudflare-outcome")).toBe("connected");

    const [exchange, accounts, groups, mint, reach, ...more] = asked;
    expect(more).toEqual([]);
    expect([exchange?.method, exchange?.url]).toEqual(["POST", TOKEN_URL]);
    expect(exchange?.authorization).toBe(
      `Basic ${btoa(`${formEncode("keel-test-client")}:${formEncode(CLIENT_SECRET)}`)}`,
    );
    const form = new URLSearchParams(exchange?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe(query.get("redirect_uri"));
    expect(await challengeOf(form.get("code_verifier") ?? "")).toBe(query.get("code_challenge"));
    expect([accounts?.url, accounts?.authorization]).toEqual([
      `${CLOUDFLARE_API}/accounts`,
      `Bearer ${ACCESS}`,
    ]);
    expect(groups?.authorization).toBe(`Bearer ${ACCESS}`);
    expect([mint?.method, mint?.url, mint?.authorization]).toEqual([
      "POST",
      `${CLOUDFLARE_API}/accounts/${ACCOUNT}/tokens`,
      `Bearer ${ACCESS}`,
    ]);
    // Exactly Workers Scripts Write, on exactly the account the consent granted.
    const minted = JSON.parse(mint?.body ?? "{}");
    expect(minted.policies).toEqual([
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
        permission_groups: [{ id: GROUP }],
      },
    ]);
    expect(String(minted.name)).toMatch(/^Keel deploys: pool\/[^/]+$/);
    // The target is checked, and later deploys, with the minted token: never the consent's.
    expect([reach?.url, reach?.authorization]).toEqual([
      `${CLOUDFLARE_API}/accounts/${ACCOUNT}/workers/subdomain`,
      `Bearer ${MINTED}`,
    ]);

    const targets = await call(`/projects/${projectId}/deploy-targets`, { token: owner.token });
    expect(targets.json["targets"]).toEqual([
      {
        name: "production",
        provider: "cloudflare",
        accountId: ACCOUNT,
        credential: expect.stringMatching(/^crd_/),
        workersDev: "acme.workers.dev",
      },
    ]);
    const credentials = await call("/namespaces/pool/credentials", { token: owner.token });
    expect(credentials.json["credentials"]).toContainEqual(
      expect.objectContaining({
        label: minted.name,
        provider: "cloudflare",
        createdBy: owner.userId,
      }),
    );
    // No answer carries the consent's token, the minted one or the verifier: not a body, not the redirect.
    for (const answer of [back, targets, credentials])
      for (const secret of [ACCESS, MINTED, form.get("code_verifier") ?? "-"])
        expect(`${answer.text} ${answer.headers.get("location") ?? ""}`.includes(secret)).toBe(
          false,
        );
  });

  it("[connect.pool.once] the same callback again finishes nothing, and Cloudflare is asked no more", async () => {
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const projectId = await freshProject();
    const asked = cloudflare();
    const state = (await begin(owner.token, projectId)).searchParams.get("state") ?? "";
    expect((await callback(owner.token, { code: "c", state })).headers.get("location")).toMatch(
      /cloudflare=connected$/,
    );
    const count = asked.length;
    const again = await callback(owner.token, { code: "c", state });
    expect([again.status, again.headers.get("keel-cloudflare-outcome")]).toEqual([303, "expired"]);
    expect(asked).toHaveLength(count);
  });

  it("[connect.pool.owner] the callback is an owner's alone: a maintainer is refused, a stranger to the state finishes nothing, and the owner's Connect still stands", async () => {
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const other = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const maintainer = await seedUser(uniqueHandle("maintainer"), { role: "maintainer" });
    const projectId = await freshProject();
    const asked = cloudflare();
    const state = (await begin(owner.token, projectId)).searchParams.get("state") ?? "";
    const refused = await callback(maintainer.token, { code: "c", state });
    expect([refused.status, refused.json["code"]]).toEqual([403, "auth.forbidden"]);
    const anonymous = await callback(undefined, { code: "c", state });
    expect(anonymous.status).toBe(401);
    const begunByMaintainer = await call(
      `/projects/${projectId}/deploy-targets/production/cloudflare-connect`,
      { token: maintainer.token, method: "POST" },
    );
    expect(begunByMaintainer.status).toBe(403);
    // Another owner of the namespace holds no Connect under this state: theirs is their own.
    const stranger = await callback(other.token, { code: "c", state });
    expect(stranger.headers.get("keel-cloudflare-outcome")).toBe("expired");
    expect(asked).toEqual([]);
    const mine = await callback(owner.token, { code: "c", state });
    expect(mine.headers.get("keel-cloudflare-outcome")).toBe("connected");
  });

  it("[connect.pool.denied] a consent the owner declined comes back denied, and spends the state", async () => {
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const projectId = await freshProject();
    const asked = cloudflare();
    const state = (await begin(owner.token, projectId)).searchParams.get("state") ?? "";
    const denied = await callback(owner.token, { error: "access_denied", state });
    expect([denied.status, denied.headers.get("location")]).toEqual([
      303,
      expect.stringMatching(/\/settings\?cloudflare=denied$/),
    ]);
    const after = await callback(owner.token, { code: "c", state });
    expect(after.headers.get("keel-cloudflare-outcome")).toBe("expired");
    expect(asked).toEqual([]);
  });

  it("[connect.pool.accounts] a consent of two accounts is refused before anything is minted, stored or set", async () => {
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const projectId = await freshProject();
    const before = await call("/namespaces/pool/credentials", { token: owner.token });
    const asked = cloudflare([ACCOUNT, OTHER_ACCOUNT]);
    const state = (await begin(owner.token, projectId)).searchParams.get("state") ?? "";
    const back = await callback(owner.token, { code: "c", state });
    expect(back.headers.get("location")).toMatch(/\/settings\?cloudflare=accounts$/);
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${CLOUDFLARE_API}/accounts`,
    ]);
    const after = await call("/namespaces/pool/credentials", { token: owner.token });
    expect(after.json["credentials"]).toEqual(before.json["credentials"]);
    const targets = await call(`/projects/${projectId}/deploy-targets`, { token: owner.token });
    expect(targets.json["targets"]).toEqual([]);
  });

  it("[connect.pool.state] a state that names no project is refused as a missing one, and Cloudflare is not asked", async () => {
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const asked = cloudflare();
    for (const state of ["", "nonsense", `${makeId("prj", ulid())}.${"x".repeat(43)}`]) {
      const back = await callback(owner.token, { code: "c", state });
      expect([state, back.status]).toEqual([state, 404]);
    }
    expect(asked).toEqual([]);
  });
});
