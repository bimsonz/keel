import { env } from "cloudflare:workers";
import { BOOTSTRAP_CLIENT_ID } from "@keeltown/core/domain/identity";
import { makeEnrolmentsMemory, makeProjectsMemory } from "@keeltown/testing";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  BASE,
  type Fetch,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";

/**
 * Project bootstrap through the real HTTP doorway, gate and handler object:
 * the bootstrap credential creates users and nothing else; a member of an org
 * creates projects there and enrols agents in them. Projects and Enrolments
 * are in-memory here; projects are placed in
 * the real D1 `projects` table, and enrolments project into the real D1
 * directory, so every credential they return exchanges for a token.
 */
const SOURCE = "fixture-forge-lite";

function operatorApp() {
  const projects = makeProjectsMemory({ sources: [SOURCE] });
  const { app } = makeIsolate(
    env,
    isolateLayer(env, { projects: projects.layer, enrolments: makeEnrolmentsMemory().layer }),
  );
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return { projects, via };
}

interface Body {
  readonly id: string;
  readonly org: string;
  readonly name: string;
  readonly viewer?: { readonly role: string };
  readonly agent: {
    readonly id: string;
    readonly projectId: string;
    readonly scopes: string[];
    readonly org?: string;
    readonly sponsor?: string;
  };
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly detail: string;
  readonly nextActions: readonly { readonly operationId?: string; readonly title: string }[];
  readonly result: { readonly agent: { readonly id: string; readonly projectId: string } };
  readonly issues?: readonly { readonly path: readonly (string | number)[] }[];
  readonly userId: string;
  readonly handle: string;
  readonly session: { readonly token: string };
}

async function call(
  via: Fetch,
  token: string,
  method: string,
  path: string,
  body?: object,
  key?: string,
) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (key !== undefined) headers.set("idempotency-key", key);
  const response = await via(`${BASE}/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json<Body>() };
}

async function exchangeAs(clientId: string, clientSecret: string, scope?: string) {
  return worker(`${BASE}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
}

async function tokenOf(clientId: string, clientSecret: string): Promise<string> {
  const response = await exchangeAs(clientId, clientSecret);
  expect(response.status).toBe(200);
  return (await response.json<{ access_token: string }>()).access_token;
}

const bootstrapToken = () => tokenOf(BOOTSTRAP_CLIENT_ID, env.KEEL_BOOTSTRAP_SECRET);
const key = (what: string) => `${what}-${crypto.randomUUID()}`;
const agentRequest = { kind: "interactive", scopes: ["agent:read", "agent:work"] };

/** A maintainer of org `pool`, signed in: who governs its projects and agents here. */
const maintainer = async () =>
  (await seedUser(uniqueHandle("maintainer"), { role: "maintainer" })).token;

/** A project name no other case in the file has placed in org `pool`. */
const projectName = (what: string) => uniqueHandle(what);

describe("project bootstrap", () => {
  it("[a11b.bootstrap] exchanges only the deployment's bootstrap secret", async () => {
    const good = await exchangeAs(BOOTSTRAP_CLIENT_ID, env.KEEL_BOOTSTRAP_SECRET);
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ token_type: "Bearer" });
    const wrong = await exchangeAs(BOOTSTRAP_CLIENT_ID, `${env.KEEL_BOOTSTRAP_SECRET}-not`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_client" });
  });

  it("[a11b.enrol] the bootstrap credential creates a user, who creates a project in its own org and enrols an agent there whose credential exchanges at once", async () => {
    const { via } = operatorApp();
    const handle = uniqueHandle("first");
    const created = await call(via, await bootstrapToken(), "POST", "/admin/users", { handle });
    expect(created.status).toBe(201);
    const user = created.body.session.token;
    const project = await call(
      via,
      user,
      "POST",
      "/projects",
      { org: handle, name: "forge", source: SOURCE },
      key("prj"),
    );
    expect(project.status).toBe(201);
    expect(project.body).toMatchObject({ org: handle, name: "forge", viewer: { role: "owner" } });
    const agent = await call(
      via,
      user,
      "POST",
      "/agents",
      { ...agentRequest, name: "worker", projectId: project.body.id },
      key("agt"),
    );
    expect(agent.status).toBe(201);
    expect(agent.body.agent).toMatchObject({
      projectId: project.body.id,
      sponsor: created.body.userId,
    });
    // The agent's token carries the project it was enrolled in (the `prj` claim).
    const me = await call(
      via,
      await tokenOf(agent.body.clientId, agent.body.clientSecret),
      "GET",
      "/agents/me",
    );
    expect(me.status).toBe(200);
    expect(me.body.result.agent).toMatchObject({
      id: agent.body.agent.id,
      projectId: project.body.id,
    });
  });

  it("[a11b.confined] refuses the bootstrap credential everything but creating users, with a next action", async () => {
    const { via, projects } = operatorApp();
    const bootstrap = await bootstrapToken();
    const refused = await call(
      via,
      bootstrap,
      "POST",
      "/projects",
      { org: "pool", name: projectName("confined"), source: SOURCE },
      key("prj"),
    );
    expect(refused.status).toBe(403);
    expect([refused.body.code, refused.body.detail]).toEqual([
      "auth.forbidden",
      "Refused: bootstrap-confined.",
    ]);
    expect(refused.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "Admin_createUser" }),
    ]);
    const enrol = await call(
      via,
      bootstrap,
      "POST",
      "/agents",
      { ...agentRequest, name: "worker", projectId: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
      key("agt"),
    );
    expect([enrol.status, enrol.body.detail]).toEqual([403, "Refused: bootstrap-confined."]);
    expect(projects.projects()).toEqual([]);
  });

  it("[a11b.create] creates a project once per key: a retry answers the same project", async () => {
    const { via, projects } = operatorApp();
    const user = await maintainer();
    const reused = key("prj");
    const name = projectName("forge");
    const first = await call(
      via,
      user,
      "POST",
      "/projects",
      { org: "pool", name, source: SOURCE },
      reused,
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      id: expect.stringMatching(/^prj_/),
      org: "pool",
      name,
      viewer: { role: "maintainer" },
    });
    const again = await call(
      via,
      user,
      "POST",
      "/projects",
      { org: "pool", name, source: SOURCE },
      reused,
    );
    expect(again).toEqual(first);
    expect(projects.projects()).toHaveLength(1);
  });

  it("[a11b.conflict] answers a reused key with another body 409, for projects and enrolments", async () => {
    const { via } = operatorApp();
    const user = await maintainer();
    const projectKey = key("prj");
    const created = await call(
      via,
      user,
      "POST",
      "/projects",
      { org: "pool", name: projectName("forge"), source: SOURCE },
      projectKey,
    );
    const project = await call(
      via,
      user,
      "POST",
      "/projects",
      { org: "pool", name: projectName("other"), source: SOURCE },
      projectKey,
    );
    expect(project.status).toBe(409);
    expect(project.body.code).toBe("request.idempotency_conflict");
    const agentKey = key("agt");
    const enrolling = { ...agentRequest, name: "worker", projectId: created.body.id };
    await call(via, user, "POST", "/agents", enrolling, agentKey);
    const agent = await call(
      via,
      user,
      "POST",
      "/agents",
      { ...enrolling, name: "other" },
      agentKey,
    );
    expect(agent.status).toBe(409);
    expect(agent.body.code).toBe("request.idempotency_conflict");
  });

  it("[a11b.source] answers a missing source repo 404, naming it, with a next action", async () => {
    const { via } = operatorApp();
    const missing = await call(
      via,
      await maintainer(),
      "POST",
      "/projects",
      { org: "pool", name: projectName("forge"), source: "no-such-repo" },
      key("prj"),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("resource.not_found");
    expect(missing.body.detail).toContain("no-such-repo");
    expect(missing.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "Operator_createProject" }),
    ]);
  });

  it("[a11e.synthetic-rest] enrols a synthetic agent whose credential exchanges at once", async () => {
    const { via } = operatorApp();
    const user = await maintainer();
    const project = await call(
      via,
      user,
      "POST",
      "/projects",
      { org: "pool", name: projectName("load"), source: SOURCE },
      key("prj"),
    );
    const enrolled = await call(
      via,
      user,
      "POST",
      "/agents",
      {
        name: "load-1",
        kind: "synthetic",
        scopes: ["agent:read", "agent:work"],
        projectId: project.body.id,
      },
      key("agt"),
    );
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.agent).toMatchObject({ kind: "synthetic" });
    const me = await call(
      via,
      await tokenOf(enrolled.body.clientId, enrolled.body.clientSecret),
      "GET",
      "/agents/me",
    );
    expect(me.body.result.agent).toMatchObject({ id: enrolled.body.agent.id, kind: "synthetic" });
  });

  it("[a11b.scope] refuses an agent's token both governing operations: governance is users' only", async () => {
    const { via } = operatorApp();
    const seeded = await seedAgent();
    const agent = await tokenFor(seeded);
    const project = await call(
      via,
      agent,
      "POST",
      "/projects",
      { org: "pool", name: projectName("forge"), source: SOURCE },
      key("prj"),
    );
    expect([project.status, project.body.detail]).toEqual([403, "Refused: users-only."]);
    const enrol = await call(
      via,
      agent,
      "POST",
      "/agents",
      { ...agentRequest, name: "worker", projectId: seeded.agent.projectId },
      key("agt"),
    );
    expect([enrol.status, enrol.body.detail]).toEqual([403, "Refused: users-only."]);
  });
});
