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
        body: JSON.stringify({ namespace: org, name: "app", source: "nowhere" }),
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
