// The gate: a Keel JWT is an agent, a Better Auth
// session (its bearer, or the console's cookie) is a user, and nothing is
// anonymous. A presented credential that is bad is refused, never read as
// anonymous; a cookie may change nothing from another origin; an agent the
// cutover has not placed is refused by name.
import { describe, expect, it } from "vitest";
import { signUpByPasskey } from "./auth-users.ts";
import { BASE, seedAgent, seedUser, tokenFor, worker } from "./helpers.ts";

const call = (path: string, init: RequestInit = {}) => worker(`${BASE}${path}`, init);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = async (response: Response) => [
  response.status,
  (await response.json<{ code?: string }>()).code,
];

describe("the gate", () => {
  it("[gate.challenge-none] a request with no credential is answered 401 with the door's challenge, as one with a bad credential is, and told it may sign up with a key; no other answer carries a challenge", async () => {
    const bad = await call("/v1/agents/me", { headers: bearer("not-a-session") });
    const challenge = bad.headers.get("www-authenticate");
    expect(challenge).toMatch(
      /^Bearer resource_metadata="https:\/\/[^"]+\/\.well-known\/oauth-protected-resource"$/,
    );
    const paths = ["/v1/agents/me", "/v1/users/me", "/v1/inbox", "/v1/inbox/stream"];
    const unsigned = await Promise.all(
      paths.map(async (path) => {
        const answered = await call(path);
        await answered.body?.cancel();
        return [path, answered.status, answered.headers.get("www-authenticate")];
      }),
    );
    expect(unsigned).toEqual(paths.map((path) => [path, 401, challenge]));
    // Neither is sent to the exchange of a secret: an agent signs up with a key, and the walk at /start says the rest.
    const arrival = [
      { kind: "call", operationId: "Auth_registerClient" },
      { kind: "read", title: expect.stringContaining("/start") },
    ];
    const told = async (answered: Response) => {
      const body = await answered.json<{ code: string; nextActions: Record<string, unknown>[] }>();
      expect(body.nextActions).toMatchObject(arrival);
      expect(body.nextActions).toHaveLength(arrival.length);
      expect(body.nextActions[1]).not.toHaveProperty("operationId");
      return body.code;
    };
    expect(await told(await call("/v1/agents/me"))).toBe("auth.required");
    expect(await told(bad)).toBe("auth.invalid_token");

    // A refusal that is not a 401 asks for no credential, and neither does an answer.
    const user = await seedUser("gate-unchallenged");
    const forbidden = await call("/v1/inbox", { headers: bearer(user.token) });
    expect([forbidden.status, forbidden.headers.get("www-authenticate")]).toEqual([403, null]);
    const open = await call("/v1/projects");
    expect([open.status, open.headers.get("www-authenticate")]).toEqual([200, null]);
  });

  it("[gate.principal] a JWT is its agent, a session bearer or cookie its user, nothing anonymous, and a bad JWT is refused rather than read as anyone", async () => {
    const agent = await tokenFor(await seedAgent());
    expect((await call("/v1/agents/me", { headers: bearer(agent) })).status).toBe(200);

    const user = await seedUser("gate-user");
    const me = await call("/v1/users/me", { headers: bearer(user.token) });
    expect(me.status).toBe(200);
    expect((await me.json<{ handle: string }>()).handle).toBe("gate-user");

    const { jar } = await signUpByPasskey("gate-browser");
    const browser = await call("/v1/users/me", { headers: { cookie: jar.header() } });
    expect([browser.status, (await browser.json<{ handle?: string }>()).handle]).toEqual([
      200,
      "gate-browser",
    ]);

    expect(await code(await call("/v1/users/me"))).toEqual([401, "auth.required"]);

    // A JWT that does not verify never falls through to a session or to anonymous: not even a public read.
    const forged = `${agent.slice(0, agent.lastIndexOf(".") + 1)}AAAA`;
    expect(await code(await call("/v1/projects", { headers: bearer(forged) }))).toEqual([
      401,
      "auth.invalid_token",
    ]);
    expect(await code(await call("/v1/projects", { headers: bearer("not-a-session") }))).toEqual([
      401,
      "auth.invalid_token",
    ]);
    expect((await call("/v1/projects")).status).toBe(200);
  });

  it("[gate.origin] a request the cookie signs in may change something only from Keel's own origin, and a bearer needs none", async () => {
    // Each user creates where it may: the passkey user in its own namespace, the seeded user in the org `pool`.
    const { jar } = await signUpByPasskey("gate-origin");
    const create = (headers: Record<string, string>, org = "gate-origin") =>
      call("/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "gate-origin-1",
          ...headers,
        },
        body: JSON.stringify({
          namespace: org,
          name: "app",
          source: { kind: "template", name: "nowhere" },
        }),
      });
    expect(await code(await create({ cookie: jar.header() }))).toEqual([403, "auth.cross_site"]);
    expect(
      await code(await create({ cookie: jar.header(), origin: "https://elsewhere.example" })),
    ).toEqual([403, "auth.cross_site"]);
    expect((await create({ cookie: jar.header(), origin: BASE })).status).not.toBe(403);

    const user = await seedUser("gate-bearer");
    expect((await create(bearer(user.token), "pool")).status).not.toBe(403);
    // A read needs no Origin, cookie or not.
    expect((await call("/v1/users/me", { headers: { cookie: jar.header() } })).status).toBe(200);
  });

  it("[gate.unplaced] an agent with no org or sponsor is refused by name, never given a default", async () => {
    const seeded = await seedAgent({}, ["agent:read", "agent:work"], { placed: false });
    const answer = await call("/v1/agents/me", { headers: bearer(await tokenFor(seeded)) });
    const body = await answer.json<{ code: string; detail: string }>();
    expect([answer.status, body.code]).toEqual([403, "auth.agent_unplaced"]);
    expect(body.detail).toContain(seeded.agent.id);
  });

  it("[gate.timing] every answer carries the gate's cost and the session read's in Server-Timing", async () => {
    const user = await seedUser("gate-timing");
    const timing = (await call("/v1/users/me", { headers: bearer(user.token) })).headers.get(
      "server-timing",
    );
    expect(timing).toMatch(/gate;dur=\d+/);
    expect(timing).toMatch(/session;dur=\d+/);
    expect((await call("/v1/projects")).headers.get("server-timing")).toMatch(
      /gate;dur=\d+, session;dur=0/,
    );
  });
});
