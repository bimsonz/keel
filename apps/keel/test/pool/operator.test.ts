import { env } from "cloudflare:workers";
import { QuotaExceeded } from "@keeltown/core/domain/identity";
import { ProjectId } from "@keeltown/core/kernel";
import { ImportRefused, ImportTooLarge } from "@keeltown/core/ports";
import { makeEnrolmentsMemory, makeProjectsMemory } from "@keeltown/testing";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { signUp } from "../../../../scripts/lib/account.ts";
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
 * a person signs up as any visitor does; a member of an org creates projects
 * there and enrols agents in them. Projects and Enrolments
 * are in-memory here; projects are placed in
 * the real D1 `projects` table, and enrolments project into the real D1
 * directory, so every credential they return exchanges for a token.
 */
const SOURCE = "fixture-forge-lite";

/**
 * Each app counts its agents from one, and every app in the file writes them to the one D1
 * directory, where an id's row keeps the namespace it was first given. A case that reads what
 * the directory says of its agent passes `agentsAfter`, for ids no other case reaches.
 */
function operatorApp(options: { readonly agentsAfter?: number } = {}) {
  const projects = makeProjectsMemory({ sources: [SOURCE] });
  const { app } = makeIsolate(
    env,
    isolateLayer(env, {
      projects: projects.layer,
      enrolments: makeEnrolmentsMemory({ after: options.agentsAfter ?? 0 }).layer,
    }),
  );
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return { projects, via };
}

interface Body {
  readonly id: string;
  readonly namespace: { readonly handle: string; readonly kind: string };
  readonly name: string;
  readonly viewer?: { readonly role: string };
  readonly agent: {
    readonly id: string;
    readonly projectId: string;
    readonly scopes: string[];
    readonly namespace?: string;
    readonly sponsor?: string;
  };
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly detail: string;
  readonly nextActions: readonly { readonly operationId?: string; readonly title: string }[];
  readonly result: { readonly agent: { readonly id: string; readonly projectId: string } };
  readonly issues?: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];
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

const key = (what: string) => `${what}-${crypto.randomUUID()}`;
const agentRequest = { kind: "interactive", scopes: ["agent:read", "agent:work"] };

/** A maintainer of org `pool`, signed in: who governs its projects and agents here. */
const maintainer = async () =>
  (await seedUser(uniqueHandle("maintainer"), { role: "maintainer" })).token;

/** A project name no other case in the file has placed in org `pool`. */
const projectName = (what: string) => uniqueHandle(what);

describe("project bootstrap", () => {
  it("[a11b.enrol] a person who signs up by passkey creates a project in their own namespace and enrols an agent there whose credential exchanges at once", async () => {
    const { via } = operatorApp();
    const handle = uniqueHandle("first");
    const { session } = await signUp(BASE, handle, {
      fetcher: (request) => via(request.url, request),
    });
    const user = session.token;
    const project = await call(
      via,
      user,
      "POST",
      "/projects",
      { namespace: handle, name: "forge", source: { kind: "template", name: SOURCE } },
      key("prj"),
    );
    expect(project.status).toBe(201);
    expect(project.body).toMatchObject({
      namespace: { handle, kind: "user" },
      name: "forge",
      viewer: { role: "owner" },
    });
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
      sponsor: session.userId,
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

  it("[ns.own-project] a person owns the namespace that is their own by being that person: they create there, their agent works there under their id, and nobody else creates there", async () => {
    const { via } = operatorApp({ agentsAfter: Date.now() });
    const handle = uniqueHandle("own");
    const { session } = await signUp(BASE, handle, {
      fetcher: (request) => via(request.url, request),
    });
    const project = await call(
      via,
      session.token,
      "POST",
      "/projects",
      { namespace: handle.toUpperCase(), name: "mine", source: { kind: "template", name: SOURCE } },
      key("prj"),
    );
    expect(project.status).toBe(201);
    expect(project.body).toMatchObject({
      namespace: { handle, kind: "user" },
      viewer: { role: "owner" },
    });
    const read = await call(via, session.token, "GET", `/namespaces/${handle}/projects/mine`);
    expect([read.status, read.body.id]).toEqual([200, project.body.id]);

    const agent = await call(
      via,
      session.token,
      "POST",
      "/agents",
      { ...agentRequest, name: "own-worker", projectId: project.body.id },
      key("agt"),
    );
    expect(agent.status).toBe(201);
    expect(agent.body.agent).toMatchObject({
      namespace: session.userId,
      sponsor: session.userId,
    });
    const asAgent = await tokenOf(agent.body.clientId, agent.body.clientSecret);
    const me = await call(via, asAgent, "GET", "/agents/me");
    expect([me.status, me.body.result.agent]).toMatchObject([
      200,
      { id: agent.body.agent.id, projectId: project.body.id },
    ]);
    // The agent stands on its sponsor's ownership: it reads the private project it works in.
    const worked = await call(via, asAgent, "GET", `/namespaces/${handle}/projects/mine`);
    expect([worked.status, worked.body.id]).toEqual([200, project.body.id]);

    // A member of an org is nobody in a person's namespace, and a person's namespace takes no members.
    const other = await maintainer();
    const theirs = await call(
      via,
      other,
      "POST",
      "/projects",
      { namespace: handle, name: "theirs", source: { kind: "template", name: SOURCE } },
      key("prj"),
    );
    expect([theirs.status, theirs.body.code]).toEqual([403, "auth.forbidden"]);
    const hidden = await call(via, other, "GET", `/namespaces/${handle}/projects/mine`);
    expect(hidden.status).toBe(404);
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
      { namespace: "pool", name, source: { kind: "template", name: SOURCE } },
      reused,
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      id: expect.stringMatching(/^prj_/),
      namespace: { handle: "pool", kind: "org" },
      name,
      viewer: { role: "maintainer" },
    });
    const again = await call(
      via,
      user,
      "POST",
      "/projects",
      { namespace: "pool", name, source: { kind: "template", name: SOURCE } },
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
      { namespace: "pool", name: projectName("forge"), source: { kind: "template", name: SOURCE } },
      projectKey,
    );
    const project = await call(
      via,
      user,
      "POST",
      "/projects",
      { namespace: "pool", name: projectName("other"), source: { kind: "template", name: SOURCE } },
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
      {
        namespace: "pool",
        name: projectName("forge"),
        source: { kind: "template", name: "no-such-repo" },
      },
      key("prj"),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("resource.not_found");
    expect(missing.body.detail).toContain("no-such-repo");
    expect(missing.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "Operator_createProject" }),
    ]);
  });

  it("[a11b.starts] an empty project and an import reach the Project DO as the doorway read them: the import's URL as it will be recorded, and its branch", async () => {
    const { projects, via } = operatorApp();
    const user = await maintainer();
    const create = (name: string, source: object) =>
      call(via, user, "POST", "/projects", { namespace: "pool", name, source }, key("prj"));

    const empty = await create(projectName("empty"), { kind: "empty" });
    const imported = await create(projectName("imported"), {
      kind: "import",
      url: "https://Git.Example/team/app",
      ref: "release/1.x",
    });
    expect([empty.status, imported.status]).toEqual([201, 201]);
    expect([
      projects.starts.get(Schema.decodeUnknownSync(ProjectId)(empty.body.id)),
      projects.starts.get(Schema.decodeUnknownSync(ProjectId)(imported.body.id)),
    ]).toEqual([
      { _tag: "Empty" },
      { _tag: "Import", url: "https://git.example/team/app", ref: "release/1.x" },
    ]);
  });

  it("[a11b.source-refused] an import whose URL or branch Keel takes none like is 400, naming the field and why, and reaches no Project DO", async () => {
    const { projects, via } = operatorApp();
    const user = await maintainer();
    const refusals = [];
    for (const source of [
      { kind: "import", url: "https://user:secret@git.example/team/app" },
      { kind: "import", url: "http://git.example/team/app" },
      { kind: "import", url: "https://git.example/team/app", ref: "refs/heads/main" },
    ]) {
      const refused = await call(
        via,
        user,
        "POST",
        "/projects",
        { namespace: "pool", name: projectName("refused"), source },
        key("prj"),
      );
      refusals.push([refused.status, refused.body.code, refused.body.issues, refused.body.detail]);
    }
    expect(refusals).toEqual([
      [
        400,
        "request.invalid",
        [{ path: ["body", "source", "url"], message: expect.stringContaining("user name") }],
        expect.stringContaining("(credential)"),
      ],
      [
        400,
        "request.invalid",
        [{ path: ["body", "source", "url"], message: "must begin with https://" }],
        expect.stringContaining("(not-https)"),
      ],
      [
        400,
        "request.invalid",
        [{ path: ["body", "source", "ref"], message: expect.stringContaining("short name") }],
        expect.stringContaining("(not-a-branch)"),
      ],
    ]);
    expect(projects.projects()).toEqual([]);
  });

  it("[a11b.start-refused] a start the Project DO refuses is said by its own problem, with a next action, and the name it asked for is free again", async () => {
    const { projects, via } = operatorApp();
    const user = await maintainer();
    const name = projectName("wanted");
    const source = { kind: "import", url: "https://git.example/team/app" };
    const create = () =>
      call(via, user, "POST", "/projects", { namespace: "pool", name, source }, key("prj"));
    const answers = [];
    for (const refusal of [
      new ImportRefused({ reason: "not-found" }),
      new ImportRefused({ reason: "no-branch" }),
      new ImportRefused({ reason: "unreachable" }),
      new ImportRefused({ reason: "too-large" }),
      new ImportTooLarge({ projectId: "prj_x", bytes: 70_000_000, limit: 62_914_560 }),
      new QuotaExceeded({
        kind: "repo-bytes",
        reason: "limit",
        limit: 5_000,
        used: 4_000,
        requested: 4_000,
        nextActions: [{ kind: "escalate", title: "Ask an owner to raise the namespace's limit" }],
      }),
    ]) {
      projects.refuse(refusal);
      const refused = await create();
      answers.push([
        refused.status,
        refused.body.code,
        refused.body.nextActions.map((next) => next.title),
      ]);
    }
    expect(answers).toEqual([
      [404, "project.import_refused", [expect.stringContaining("public repository")]],
      [404, "project.import_refused", [expect.stringContaining("branch")]],
      [503, "project.import_refused", [expect.stringContaining("again shortly")]],
      [403, "project.import_refused", [expect.stringContaining("smaller repository")]],
      [403, "project.import_too_large", [expect.stringContaining("smaller repository")]],
      [
        403,
        "quota.exceeded",
        [
          "Ask an owner to raise the namespace's limit",
          expect.stringContaining("namespace with room"),
        ],
      ],
    ]);
    // Six refusals under six keys asked for one name: none of them holds it.
    projects.refuse(undefined);
    const made = await create();
    expect([made.status, made.body.name]).toEqual([201, name]);
  });

  it("[a11e.synthetic-rest] enrols a synthetic agent whose credential exchanges at once", async () => {
    const { via } = operatorApp();
    const user = await maintainer();
    const project = await call(
      via,
      user,
      "POST",
      "/projects",
      { namespace: "pool", name: projectName("load"), source: { kind: "template", name: SOURCE } },
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
      { namespace: "pool", name: projectName("forge"), source: { kind: "template", name: SOURCE } },
      key("prj"),
    );
    expect([project.status, project.body.detail]).toEqual([403, "Refused: users-only."]);
    const made = await call(
      via,
      await maintainer(),
      "POST",
      "/projects",
      { namespace: "pool", name: projectName("forge"), source: { kind: "template", name: SOURCE } },
      key("prj"),
    );
    expect(made.status).toBe(201);
    const enrol = await call(
      via,
      agent,
      "POST",
      "/agents",
      { ...agentRequest, name: "worker", projectId: made.body.id },
      key("agt"),
    );
    expect([enrol.status, enrol.body.detail]).toEqual([403, "Refused: users-only."]);
    // A project this app does not hold is missing to an agent as to anyone, before any role is weighed.
    const nowhere = await call(
      via,
      agent,
      "POST",
      "/agents",
      { ...agentRequest, name: "worker", projectId: seeded.agent.projectId },
      key("agt"),
    );
    expect(nowhere.status).toBe(404);
  });
});
