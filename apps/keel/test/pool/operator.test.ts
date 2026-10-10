import { env } from "cloudflare:workers";
import { BOOTSTRAP_CLIENT_ID, PLATFORM_PROJECT_ID } from "@keeltown/core/domain/identity";
import { makeEnrolmentsMemory, makeProjectsMemory } from "@keeltown/testing";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { BASE, type Fetch, seedAgent, tokenFor, worker } from "./helpers.ts";

/**
 * Project bootstrap through the real HTTP doorway, auth gate and handler
 * object: the bootstrap credential enrols the first operator and nothing else;
 * the operator creates projects and enrols agents. Projects and Enrolments are
 * in-memory here; enrolments project into the
 * real D1 directory, so every credential they return exchanges for a token.
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
  readonly name: string;
  readonly agent: { readonly id: string; readonly projectId: string; readonly scopes: string[] };
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly detail: string;
  readonly nextActions: readonly { readonly operationId?: string; readonly title: string }[];
  readonly result: { readonly agent: { readonly id: string; readonly projectId: string } };
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
const operatorRequest = { name: "operator", kind: "hosted", scopes: ["operator"] };

/** Enrols a real operator through the bootstrap credential and returns its token. */
async function operatorToken(via: Fetch): Promise<string> {
  const enrolled = await call(
    via,
    await bootstrapToken(),
    "POST",
    "/agents",
    operatorRequest,
    key("op"),
  );
  expect(enrolled.status).toBe(201);
  return tokenOf(enrolled.body.clientId, enrolled.body.clientSecret);
}

describe("project bootstrap", () => {
  it("[a11b.bootstrap] exchanges only the deployment's bootstrap secret, for an operator token", async () => {
    const good = await exchangeAs(BOOTSTRAP_CLIENT_ID, env.KEEL_BOOTSTRAP_SECRET);
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ scope: "operator" });
    const wrong = await exchangeAs(BOOTSTRAP_CLIENT_ID, `${env.KEEL_BOOTSTRAP_SECRET}-not`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_client" });
  });

  it("[a11b.enrol] enrols an operator whose credential exchanges at once, in the platform project", async () => {
    const { via } = operatorApp();
    const enrolled = await call(
      via,
      await bootstrapToken(),
      "POST",
      "/agents",
      operatorRequest,
      key("op"),
    );
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.agent).toMatchObject({
      projectId: PLATFORM_PROJECT_ID,
      scopes: ["operator"],
    });
    const operator = await tokenOf(enrolled.body.clientId, enrolled.body.clientSecret);
    const project = await call(
      via,
      operator,
      "POST",
      "/projects",
      { name: "forge", source: SOURCE },
      key("prj"),
    );
    expect(project.status).toBe(201);
    const agent = await call(
      via,
      operator,
      "POST",
      "/agents",
      {
        name: "worker",
        kind: "interactive",
        scopes: ["agent:read", "agent:work"],
        projectId: project.body.id,
      },
      key("agt"),
    );
    expect(agent.status).toBe(201);
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

  it("[a11b.confined] refuses the bootstrap credential everything but enrolment, with a next action", async () => {
    const { via, projects } = operatorApp();
    const refused = await call(
      via,
      await bootstrapToken(),
      "POST",
      "/projects",
      { name: "forge", source: SOURCE },
      key("prj"),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("auth.insufficient_scope");
    expect(refused.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "Operator_enrolAgent" }),
    ]);
    expect(projects.projects()).toEqual([]);
  });

  it("[a11b.create] creates a project once per key: a retry answers the same project", async () => {
    const { via, projects } = operatorApp();
    const operator = await operatorToken(via);
    const reused = key("prj");
    const first = await call(
      via,
      operator,
      "POST",
      "/projects",
      { name: "forge", source: SOURCE },
      reused,
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: expect.stringMatching(/^prj_/), name: "forge" });
    const again = await call(
      via,
      operator,
      "POST",
      "/projects",
      { name: "forge", source: SOURCE },
      reused,
    );
    expect(again).toEqual(first);
    expect(projects.projects()).toHaveLength(1);
  });

  it("[a11b.conflict] answers a reused key with another body 409, for projects and enrolments", async () => {
    const { via } = operatorApp();
    const operator = await operatorToken(via);
    const projectKey = key("prj");
    await call(via, operator, "POST", "/projects", { name: "forge", source: SOURCE }, projectKey);
    const project = await call(
      via,
      operator,
      "POST",
      "/projects",
      { name: "other", source: SOURCE },
      projectKey,
    );
    expect(project.status).toBe(409);
    expect(project.body.code).toBe("request.idempotency_conflict");
    const agentKey = key("agt");
    await call(via, operator, "POST", "/agents", operatorRequest, agentKey);
    const agent = await call(
      via,
      operator,
      "POST",
      "/agents",
      { ...operatorRequest, name: "other" },
      agentKey,
    );
    expect(agent.status).toBe(409);
    expect(agent.body.code).toBe("request.idempotency_conflict");
  });

  it("[a11b.source] answers a missing source repo 404, naming it, with a next action", async () => {
    const { via } = operatorApp();
    const missing = await call(
      via,
      await operatorToken(via),
      "POST",
      "/projects",
      { name: "forge", source: "no-such-repo" },
      key("prj"),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("resource.not_found");
    expect(missing.body.detail).toContain("no-such-repo");
    expect(missing.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "Operator_createProject" }),
    ]);
  });

  it("[a11b.scope] refuses an agent's token both operator operations", async () => {
    const { via } = operatorApp();
    const agent = await tokenFor(await seedAgent());
    const project = await call(
      via,
      agent,
      "POST",
      "/projects",
      { name: "forge", source: SOURCE },
      key("prj"),
    );
    expect(project.status).toBe(403);
    const enrol = await call(via, agent, "POST", "/agents", operatorRequest, key("agt"));
    expect(enrol.status).toBe(403);
  });
});
