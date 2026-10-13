// What a request is told when D1 is away for a moment, through the real gate,
// handlers, Better Auth and the app's own error handler: 503 with a wait, and
// never 500. D1 cannot be put away on purpose, so the app runs over a `DB`
// that rejects chosen statements with D1's own sentence. The database is two
// seams: Better Auth's (`env.DB` as `makeIsolate` is given it) and Keel's own
// adapters' (the one `isolateLayer` is given); each case puts one of them away.
import { env } from "cloudflare:workers";
import { namespaceAddress } from "@keeltown/core/application/coordination";
import { agentIdOf } from "@keeltown/core/domain/identity";
import { makeId, type NamespaceId, type ProjectId, type UserId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  type Fetch,
  placeProject,
  seedOrg,
  seedUser,
  uniqueHandle,
  worker,
} from "./helpers.ts";

/** What D1 says when its connection drops, as the binding throws it. */
const LOST = "D1_ERROR: Network connection lost.";
/** What D1 says of a query that is wrong: Keel's own defect, and nothing a wait mends. */
const NO_TABLE = "D1_ERROR: no such table: nowhere: SQLITE_ERROR";

const EVERY = () => true;
const NONE = () => false;

/**
 * `db`, which can be put away: while `put` holds a rule, a statement whose SQL
 * the rule names rejects with `says` where it would have reached the database,
 * and is written down in `refused`. Everything else passes through.
 */
function awayDb(db: D1Database, says: string) {
  let away: (sql: string) => boolean = NONE;
  const refused: string[] = [];
  const inner = new WeakMap<object, { readonly sql: string; readonly real: D1PreparedStatement }>();
  const refuse = (sql: string) => {
    refused.push(sql);
    return Promise.reject(new Error(says));
  };
  const statement = (sql: string, real: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(real, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => statement(sql, target.bind(...values));
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key !== "first" && key !== "all" && key !== "run" && key !== "raw")
          return value.bind(target);
        return (...given: unknown[]): unknown =>
          away(sql) ? refuse(sql) : Reflect.apply(value, target, given);
      },
    });
    inner.set(proxy, { sql, real });
    return proxy;
  };
  const stub = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => statement(sql, target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          const met = statements.map((one) => inner.get(one)?.sql ?? "").find((sql) => away(sql));
          return met === undefined
            ? target.batch(statements.map((one) => inner.get(one)?.real ?? one))
            : refuse(met);
        };
      if (key === "exec") return (sql: string) => (away(sql) ? refuse(sql) : target.exec(sql));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: stub,
    refused,
    /** Puts away every statement `rule` names, until `back`. */
    put: (rule: (sql: string) => boolean) => {
      away = rule;
    },
    back: () => {
      away = NONE;
    },
  };
}

/** The app whose Better Auth reads a database that can be put away; Keel's own adapters read the real one. */
function overAuthDb(says = LOST) {
  const database = awayDb(env.DB, says);
  const { app } = makeIsolate({ ...env, DB: database.db }, isolateLayer(env));
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return { ...database, via };
}

/** The app whose own adapters read a database that can be put away; Better Auth reads the real one. */
function overOwnDb(says = LOST) {
  const database = awayDb(env.DB, says);
  const { app } = makeIsolate(env, isolateLayer({ ...env, DB: database.db }));
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return { ...database, via };
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });

/** Better Auth's read of a session by its token: the one statement of a request that its own catch surrounds. */
const SESSION_READ = (sql: string) => /\bfrom "session"/i.test(sql);

/** A `get-session` answer's status, and the user it names. */
const whose = async (response: Response) => [
  response.status,
  (await response.json<{ user?: { id: string } }>()).user?.id,
];

/** The ids a list of projects names, once it has answered 200. */
async function listed(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json<{ items: { id: string }[] }>()).items.map((item) => item.id);
}

/** The one answer a request that met the database while it was away is given. */
async function toldToWait(response: Response) {
  expect([
    response.status,
    response.headers.get("retry-after"),
    response.headers.get("content-type"),
  ]).toEqual([503, "2", "application/problem+json"]);
  expect(await response.json()).toMatchObject({
    type: "urn:keel:problem:service.unavailable",
    status: 503,
    code: "service.unavailable",
    detail:
      "Keel's database did not answer just now. Send the request again after retryAfterMs, with the same Idempotency-Key if it carried one.",
    retryAfterMs: 2000,
    nextActions: [{ kind: "wait", title: "Send the request again after retryAfterMs" }],
  });
}

const codeOf = async (response: Response) => [
  response.status,
  (await response.json<{ code?: string }>()).code,
];

/** An org of one owner, with a member signed in by passkey. */
async function anOrg() {
  const org: NamespaceId = makeId("org", ulid());
  const slug = uniqueHandle("away");
  const owner: UserId = makeId("usr", ulid());
  await seedOrg(org, slug, owner, uniqueHandle("owner"));
  const member = await seedUser(uniqueHandle("ann"), { org, signedInBy: "passkey" });
  return { org, slug, member };
}

const REGISTER = `${BASE}/v1/oauth/register`;

/** An agent that signed itself up through the Worker with a key and nothing else, and its token for one project. */
async function keyAgent() {
  const account = await newKey();
  const registered = await worker(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": freshAddress(),
      dpop: await proofBy(account, "POST", REGISTER),
    },
    body: JSON.stringify({
      jwks: { keys: [account.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    }),
  });
  expect(registered.status).toBe(201);
  const agentId = agentIdOf(account.key.jkt);
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));
  const card = await worker(`${BASE}/v1/agents/${agentId}`);
  const { handle } = await card.json<{ handle: string }>();
  const token = async (project?: ProjectId) =>
    (await granted(await requestToken(agentId, account, project === undefined ? {} : { project })))
      .access_token;
  return { handle, token };
}

describe("a database that is away, through the real doorway", () => {
  it("[d1.away-session] a signed-in person whose session cannot be read is told to wait, 503 with Retry-After, and is themselves again once the database is back", async () => {
    const { org, member } = await anOrg();
    const projectId: ProjectId = makeId("prj", ulid());
    await placeProject(projectId, org);
    const app = overAuthDb();
    /** The member's own list, which names their org's private project to them and to no visitor. */
    const mine = () => app.via(`${BASE}/v1/projects?limit=100`, { headers: as(member.token) });
    expect(await listed(await mine())).toEqual([projectId]);

    // The session's read alone is away: Better Auth has started, and its own catch makes of any error but its own a failure that names no cause.
    app.put(SESSION_READ);
    await toldToWait(await mine());
    expect(app.refused.map(SESSION_READ)).toEqual([true]);

    // Everything is away, as in an export: Better Auth cannot start, and what it throws is D1's own error.
    app.put(EVERY);
    await toldToWait(await mine());
    expect(app.refused.length).toBeGreaterThan(1);

    app.back();
    expect(await listed(await mine())).toEqual([projectId]);
  });

  it("[d1.away-mount] Better Auth's own route answers Keel's 503 with the wait, not a bare one of its own", async () => {
    const person = await seedUser(uniqueHandle("away"), { role: null });
    const app = overAuthDb();
    const session = () => app.via(`${BASE}/v1/auth/get-session`, { headers: as(person.token) });
    expect(await whose(await session())).toEqual([200, person.userId]);

    // The session's read alone is away: Better Auth answers for itself, a 503 that is no problem and names no wait.
    app.put(SESSION_READ);
    await toldToWait(await session());
    expect(app.refused.map(SESSION_READ)).toEqual([true]);

    // Everything is away: Better Auth cannot start and answers nothing, so the app's own catch does.
    app.put(EVERY);
    await toldToWait(await session());
    expect(app.refused.length).toBeGreaterThan(1);

    app.back();
    expect(await whose(await session())).toEqual([200, person.userId]);
  });

  it("[d1.away-principal] an agent invited into an org, whose standing there cannot be read, is told to wait: not 401, which would have it throw a good token away, and not 500", async () => {
    const { org, slug, member } = await anOrg();
    const projectId: ProjectId = makeId("prj", ulid());
    await placeProject(projectId, org);
    await establishProject(projectId);
    drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(org))));
    const agent = await keyAgent();
    const invited = await worker(`${BASE}/v1/namespaces/${slug}/agents`, {
      method: "POST",
      headers: {
        ...as(member.token),
        "content-type": "application/json",
        "idempotency-key": `key-${ulid()}`,
      },
      body: JSON.stringify({ agent: agent.handle }),
    });
    expect(invited.status).toBe(201);
    const accepted = await worker(`${BASE}/v1/agents/me/namespaces/${org}`, {
      method: "PUT",
      headers: { ...as(await agent.token()), "idempotency-key": `key-${ulid()}` },
    });
    expect(accepted.status).toBe(200);

    const inOrg = await agent.token(projectId);
    const app = overOwnDb();
    const read = () => app.via(`${BASE}/v1/changes?project=${projectId}`, { headers: as(inOrg) });
    expect((await read()).status).toBe(200);

    app.put((sql) => sql.includes("namespace_agents"));
    await toldToWait(await read());
    expect(app.refused.length).toBeGreaterThan(0);

    app.back();
    expect((await read()).status).toBe(200);
  });

  it("[d1.away-directory] a visitor's list of projects, read while the database is away, is told to wait with the header a client's own retry reads", async () => {
    const app = overOwnDb();
    const list = () => app.via(`${BASE}/v1/projects?limit=1`);
    expect((await list()).status).toBe(200);

    app.put(EVERY);
    await toldToWait(await list());
    expect(app.refused.length).toBeGreaterThan(0);

    app.back();
    expect((await list()).status).toBe(200);
  });

  it("[d1.away-quota] a project whose place cannot be written is not made: its maker is told to wait, and the namespace holds what it held", async () => {
    const { org, slug, member } = await anOrg();
    await placeProject(makeId("prj", ulid()), org);
    const held = async () =>
      (
        await env.DB.prepare("SELECT id FROM projects WHERE namespace_id = ? ORDER BY id")
          .bind(org)
          .all<{ id: string }>()
      ).results.map((row) => row.id);
    const before = await held();
    expect(before).toHaveLength(1);

    const app = overOwnDb();
    app.put((sql) => sql.includes("INSERT INTO projects"));
    const made = await app.via(`${BASE}/v1/projects`, {
      method: "POST",
      headers: {
        ...as(member.token),
        "content-type": "application/json",
        "idempotency-key": `key-${ulid()}`,
      },
      body: JSON.stringify({
        namespace: slug,
        name: uniqueHandle("app"),
        source: { kind: "template", name: "fixture-forge-lite" },
      }),
    });
    await toldToWait(made);
    // The one statement kept from the database is the place's own insert, met once.
    expect(app.refused.map((sql) => sql.includes("INSERT INTO projects"))).toEqual([true]);
    expect(await held()).toEqual(before);
  });

  it("[d1.other-is-defect] a query that is wrong is still Keel's defect, 500, on the session's read and on the list's: only D1 saying it is away is a wait", async () => {
    const person = await seedUser(uniqueHandle("away"), { role: null });
    const auth = overAuthDb(NO_TABLE);
    auth.put(EVERY);
    const mine = await auth.via(`${BASE}/v1/projects?limit=1`, { headers: as(person.token) });
    expect(await codeOf(mine)).toEqual([500, "internal.defect"]);
    expect(auth.refused.length).toBeGreaterThan(0);

    const own = overOwnDb(NO_TABLE);
    own.put(EVERY);
    const list = await own.via(`${BASE}/v1/projects?limit=1`);
    expect(list.headers.get("retry-after")).toBeNull();
    expect(await codeOf(list)).toEqual([500, "internal.defect"]);
    expect(own.refused.length).toBeGreaterThan(0);
  });
});
