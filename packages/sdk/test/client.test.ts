import { describe, expect, it } from "vitest";
import { createKeelClient, KeelProblem, KeelTokenError } from "../src/index.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A fake Keel: answers the token endpoint and then whatever `respond` scripts, recording every request. */
function fakeKeel(respond: (request: Sent, call: number) => Response) {
  const sent: Sent[] = [];
  let tokens = 0;
  let calls = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Sent = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    sent.push(request);
    if (url.endsWith("/v1/oauth/token")) {
      tokens += 1;
      return Response.json({
        access_token: `token-${tokens}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "agent:work",
      });
    }
    calls += 1;
    return respond(request, calls);
  };
  const client = createKeelClient({
    baseUrl: "https://keel.test/",
    clientId: "client-a",
    clientSecret: "secret-a",
    fetch,
  });
  return { client, sent, tokens: () => tokens };
}

const ok = (body: object = { ok: true }) => Response.json(body);
const problem = (status: number, code: string, extra: object = {}) =>
  new Response(
    JSON.stringify({
      type: `urn:keel:problem:${code}`,
      title: code,
      status,
      code,
      requestId: "req-1",
      nextActions: [{ kind: "call", title: "Exchange again", operationId: "Auth_exchangeToken" }],
      ...extra,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

describe("the Keel client", () => {
  it("[sdk.token] exchanges once and reuses the token, then refreshes once on a 401 and retries under the same key", async () => {
    const keel = fakeKeel((request, call) =>
      call === 2
        ? problem(401, "auth.invalid_token")
        : ok({ seen: request.headers["authorization"] }),
    );
    await keel.client.whoami();
    expect(keel.tokens()).toBe(1);
    await keel.client.declare(
      { goal: "g", footprint: [], premises: [] },
      { idempotencyKey: "key-0001" },
    );
    expect(keel.tokens()).toBe(2);
    const declares = keel.sent.filter((s) => s.url.endsWith("/v1/changes"));
    expect(declares.map((s) => s.headers["authorization"])).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(declares.map((s) => s.headers["idempotency-key"])).toEqual(["key-0001", "key-0001"]);
  });

  it("[sdk.request] puts each input where the route says: path, query, headers, body", async () => {
    const keel = fakeKeel(() => ok());
    await keel.client.submit(
      { changeId: "chg_1", commitSha: "a".repeat(40) },
      { lease: "lse_1", idempotencyKey: "key-0002" },
    );
    await keel.client.status("chg_1", { wait: 20 });
    await keel.client.inbox({ cursor: "000000000004" });
    const [submit, status, inbox] = keel.sent.filter((s) => !s.url.endsWith("/oauth/token"));
    expect(submit).toMatchObject({ url: "https://keel.test/v1/submissions", method: "POST" });
    expect(submit?.headers).toMatchObject({ "keel-lease": "lse_1", "idempotency-key": "key-0002" });
    expect(JSON.parse(submit?.body ?? "{}")).toEqual({
      changeId: "chg_1",
      commitSha: "a".repeat(40),
    });
    expect(status).toMatchObject({
      url: "https://keel.test/v1/changes/chg_1/submission?wait=20",
      method: "GET",
      body: undefined,
    });
    expect(inbox?.url).toBe("https://keel.test/v1/inbox?cursor=000000000004");
  });

  it("[sdk.problem] throws a KeelProblem carrying the code, the next actions and the retry hint", async () => {
    const keel = fakeKeel(() => problem(503, "workspace.pool_exhausted", { retryAfterMs: 1500 }));
    const error = await keel.client
      .declare({ goal: "g", footprint: [], premises: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeelProblem);
    expect(error).toMatchObject({
      status: 503,
      code: "workspace.pool_exhausted",
      retryAfterMs: 1500,
      nextActions: [expect.objectContaining({ operationId: "Auth_exchangeToken" })],
    });
  });

  it("mints an Idempotency-Key when none is given", async () => {
    const keel = fakeKeel(() => ok());
    await keel.client.createProject({ name: "forge", source: "fixture-forge-lite" });
    const create = keel.sent.find((s) => s.url.endsWith("/v1/projects"));
    expect(create?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports a refused credential as a KeelTokenError with the RFC 6749 error", async () => {
    const client = createKeelClient({
      baseUrl: "https://keel.test",
      clientId: "client-a",
      clientSecret: "wrong",
      fetch: async () => Response.json({ error: "invalid_client" }, { status: 401 }),
    });
    const error = await client.whoami().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeelTokenError);
    expect(error).toMatchObject({ error: "invalid_client", status: 401 });
  });

  it("[sdk.public] a client with no credentials sends no token, never asks for one, and is refused as itself", async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const client = createKeelClient({
      baseUrl: "https://keel.test",
      fetch: async (url, init) => {
        sent.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
        return url.includes("/repo/blob")
          ? problem(404, "resource.not_found")
          : ok({ commit: "a".repeat(40), path: "", entries: [] });
      },
    });
    await client.tree("prj_25R7GR504NN2N2MB7JTCFBPPQ8", { path: "src" });
    const refused = await client
      .blob("prj_25R7GR504NN2N2MB7JTCFBPPQ8", "src/index.ts")
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(KeelProblem);
    expect(sent.map((s) => s.url)).toEqual([
      "https://keel.test/v1/projects/prj_25R7GR504NN2N2MB7JTCFBPPQ8/repo/tree?path=src",
      "https://keel.test/v1/projects/prj_25R7GR504NN2N2MB7JTCFBPPQ8/repo/blob?path=src%2Findex.ts",
    ]);
    expect(sent.every((s) => s.headers["authorization"] === undefined)).toBe(true);
    await expect(client.token()).rejects.toBeInstanceOf(KeelTokenError);
  });
});
