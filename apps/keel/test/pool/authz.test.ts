// The one authorization policy as the doorway answers it, through the real
// identity), through the real gate, handlers and DOs, over REST and MCP: who
// sees a project, what each audience reads, what agents and users may each do,
// and how a refusal reads. Projects are real Project DOs placed in an org; the
// repo reads and project creation run over in-memory code and projects.
import { env } from "cloudflare:workers";
import { projectRepos } from "@keeltown/core/application/integration";
import {
  type EventEnvelope,
  EventEnvelope as Envelope,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import { makeCodeHostMemory, makeProjectsMemory } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  establishProject,
  type Fetch,
  mcp,
  mcpResult,
  OTHER_ORG,
  OTHER_SPONSOR,
  placeProject,
  POOL_ORG,
  seedAgent,
  seedForeignAgent,
  seedOrg,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { project } from "./project-harness.ts";

interface Feed {
  readonly items: readonly {
    readonly eventId: string;
    readonly type: string;
    readonly project?: string;
  }[];
  readonly nextCursor: string;
}

interface Listed {
  readonly items: readonly { readonly id: string }[];
  readonly nextCursor?: string;
}

/** A request through `via` (the deployed fetch handler by default), with a bearer or none; `B` is its body. */
async function call<B = Record<string, unknown>>(
  path: string,
  options: {
    readonly token?: string;
    readonly method?: string;
    readonly body?: object;
    readonly key?: string;
    readonly via?: Fetch;
  } = {},
) {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.key !== undefined) headers.set("idempotency-key", options.key);
  const response = await (options.via ?? worker)(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json<B>() };
}

/** A refusal's body, its request id dropped and the id it was asked about blanked. */
const blank = (body: object, id?: string) => {
  const { requestId: _, ...rest } = Object(body);
  const json = JSON.stringify(rest);
  return JSON.parse(id === undefined ? json : json.replaceAll(id, "<id>"));
};

/** Events arrive as an outbox delivers them, in one batch. */
const arrive = async (...events: EventEnvelope[]) => {
  const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));
  await projector.receive(events.map((event) => Schema.encodeSync(Envelope)(event)));
};

const member = async (role: "member" | "maintainer" | "owner" = "member") =>
  seedUser(uniqueHandle(role), { role });
/** A user of org `elsewhere` only: an outsider to org `pool`. */
const outsider = async () => seedUser(uniqueHandle("outsider"), { org: OTHER_ORG });

/** A private project of org `elsewhere`, held by its Project DO. */
async function elsewhere(): Promise<ProjectId> {
  await seedOrg(OTHER_ORG, "elsewhere", OTHER_SPONSOR, "elsewhere-owner");
  const projectId = makeId("prj", ulid());
  await placeProject(projectId, OTHER_ORG);
  await establishProject(projectId);
  return projectId;
}

/** Every project `token` may list, read page by page to the end. */
async function listed(token?: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await call<Listed>(
      `/v1/projects?limit=100${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      token === undefined ? {} : { token },
    );
    expect(page.status).toBe(200);
    ids.push(...page.body.items.map((item) => item.id));
    cursor = page.body.nextCursor;
  } while (cursor !== undefined);
  return ids;
}

/** The app over in-memory code: a project's trunk holds `README.md`. */
async function repoApp(...projects: ProjectId[]): Promise<Fetch> {
  const codeHost = makeCodeHostMemory();
  for (const projectId of projects) {
    const trunk = projectRepos(projectId).trunk;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* CodeHost).create(trunk);
        yield* codeHost.fixture.commit(trunk, "refs/heads/main", { "README.md": "# hi\n" });
      }).pipe(Effect.provide(codeHost.layer)),
    );
  }
  const { app } = makeIsolate(env, isolateLayer(env, { codeHost: codeHost.layer }));
  return async (url, init) => app.fetch(new Request(url, init), env);
}

/** The project reads a visitor may make of a public project. */
const reads = (projectId: string) => [
  `/v1/changes?project=${projectId}`,
  `/v1/events?project=${projectId}`,
  `/v1/projects/${projectId}/repo/tree`,
];

describe("[authz.public-private-missing] what a visitor sees", () => {
  it("[authz.public-private-missing] reads a public project's changes, events and tree; a private project and a missing one answer the same 404, but for the request id", async () => {
    const open = await project();
    await open.open();
    const closed = await project();
    const missing = makeId("prj", ulid());
    const via = await repoApp(open.projectId, closed.projectId);

    for (const path of reads(open.projectId)) expect((await call(path, { via })).status).toBe(200);
    for (const [i, path] of reads(closed.projectId).entries()) {
      const hidden = await call(path, { via });
      const absent = await call(reads(missing)[i] ?? "", { via });
      expect([hidden.status, absent.status]).toEqual([404, 404]);
      expect(hidden.body["code"]).toBe("resource.not_found");
      expect(hidden.body["requestId"]).not.toBe(absent.body["requestId"]);
      expect(blank(hidden.body)).toEqual(blank(absent.body));
    }
  });

  it("[authz.public-private-missing] lists the public project to a visitor and not the private one; a member lists both", async () => {
    const open = await project();
    await open.open();
    const closed = await project();
    const visitor = await listed();
    const inside = await listed((await member()).token);
    expect(visitor).toContain(open.projectId);
    expect(visitor).not.toContain(closed.projectId);
    expect(inside).toEqual(expect.arrayContaining([open.projectId, closed.projectId]));
  });
});

describe("[authz.audience] who reads which events", () => {
  it("[authz.audience] an outsider reads only a public project's public events, by name or across projects; a member reads its members' events too", async () => {
    const p = await project();
    const reader = await member();
    const stranger = await outsider();
    const cursor = String(
      (await call(`/v1/events/snapshot?project=${p.projectId}`, { token: reader.token })).body[
        "cursor"
      ],
    );
    await p.open();
    const change = makeId("chg", ulid());
    await arrive(p.events.declared(change, makeId("agt", ulid()), "Cache sessions"));
    const types = async (token: string, named?: string) => {
      const page = await call<Feed>(
        `/v1/events?cursor=${cursor}&limit=500${named === undefined ? "" : `&project=${named}`}`,
        { token },
      );
      expect(page.status).toBe(200);
      return page.body.items
        .filter((event) => event.project === p.projectId)
        .map((event) => event.type);
    };

    expect(await types(stranger.token, p.projectId)).toEqual(["IntentDeclared"]);
    expect(await types(stranger.token)).toEqual(["IntentDeclared"]);
    expect(await types(reader.token, p.projectId)).toEqual([
      "ProjectSettingsChanged",
      "IntentDeclared",
    ]);
    expect(await types(reader.token)).toEqual(["ProjectSettingsChanged", "IntentDeclared"]);
  });
});

describe("[authz.agent-foreign] an agent outside its own project", () => {
  it("[authz.agent-foreign] another private project of its org is refused by name (403 foreign-project); another org's reads as missing (404)", async () => {
    const agent = await tokenFor(await seedAgent());
    const sibling = await project();
    const foreign = await elsewhere();

    const inNamespace = await call(`/v1/changes?project=${sibling.projectId}`, { token: agent });
    const outOfOrg = await call(`/v1/changes?project=${foreign}`, { token: agent });
    const missing = await call(`/v1/changes?project=${makeId("prj", ulid())}`, { token: agent });

    expect([inNamespace.status, inNamespace.body["code"], inNamespace.body["detail"]]).toEqual([
      403,
      "auth.forbidden",
      "Refused: foreign-project.",
    ]);
    expect([outOfOrg.status, outOfOrg.body["code"]]).toEqual([404, "resource.not_found"]);
    expect(blank(outOfOrg.body)).toEqual(blank(missing.body));
  });
});

describe("[authz.users-only] [authz.agents-only] governance is users', work is agents'", () => {
  it("[authz.users-only] an agent asking to put its own project's settings is refused: only a person may", async () => {
    const seeded = await seedAgent();
    const put = await call(`/v1/projects/${seeded.agent.projectId}/settings`, {
      token: await tokenFor(seeded),
      method: "PUT",
      body: { protectedPaths: [], maxBatchSize: 1 },
    });
    expect([put.status, put.body["code"], put.body["detail"]]).toEqual([
      403,
      "auth.forbidden",
      "Refused: users-only.",
    ]);
  });

  it("[authz.agents-only] a user declaring a change is refused and pointed to enrolling an agent", async () => {
    const user = await member("owner");
    const declared = await call("/v1/changes", {
      token: user.token,
      method: "POST",
      key: `declare-${ulid()}`,
      body: { goal: "Cache permission lookups per request", footprint: [], premises: [] },
    });
    expect([declared.status, declared.body["code"], declared.body["detail"]]).toEqual([
      403,
      "auth.forbidden",
      "Refused: agents-only.",
    ]);
    expect(declared.body["nextActions"]).toEqual([
      expect.objectContaining({ operationId: "Operator_enrolAgent" }),
    ]);
  });
});

describe("[authz.sponsor-left] an agent never outlasts its sponsor's membership", () => {
  it("[authz.sponsor-left] once the sponsor's member row is gone, the agent is refused its own project", async () => {
    const sponsor = await member();
    const seeded = await seedAgent({ sponsor: sponsor.userId });
    const token = await tokenFor(seeded);
    const read = () => call(`/v1/changes?project=${seeded.agent.projectId}`, { token });
    expect((await read()).status).toBe(200);

    await env.DB.prepare("DELETE FROM member WHERE userId = ? AND organizationId = ?")
      .bind(sponsor.userId, POOL_ORG)
      .run();
    const refused = await read();
    expect([refused.status, refused.body["code"], refused.body["detail"]]).toEqual([
      403,
      "auth.forbidden",
      "Refused: inviter-left.",
    ]);
  });
});

describe("[authz.suspended] suspension, of a user or of an org", () => {
  it("[authz.suspended] a banned user is refused everything, its own record too", async () => {
    const user = await member();
    const p = await project();
    expect((await call(`/v1/changes?project=${p.projectId}`, { token: user.token })).status).toBe(
      200,
    );
    await env.DB.prepare(`UPDATE "user" SET banned = 1 WHERE id = ?`).bind(user.userId).run();
    for (const path of [`/v1/changes?project=${p.projectId}`, "/v1/users/me"]) {
      const refused = await call(path, { token: user.token });
      expect([refused.status, refused.body["code"], refused.body["detail"]]).toEqual([
        403,
        "auth.forbidden",
        "Refused: user-suspended.",
      ]);
    }
  });

  it("[authz.suspended] a suspended org's member is told so; an outsider cannot tell it from nothing", async () => {
    const org = makeId("org", ulid());
    const slug = uniqueHandle("frozen");
    await seedOrg(org, slug, makeId("usr", ulid()), `${slug}-owner`);
    const projectId = makeId("prj", ulid());
    await placeProject(projectId, org);
    await establishProject(projectId);
    const inside = await seedUser(uniqueHandle("frozen-member"), { org });
    const stranger = await member();
    const read = (token: string) => call(`/v1/changes?project=${projectId}`, { token });
    expect((await read(inside.token)).status).toBe(200);

    await env.DB.prepare("UPDATE organization SET suspended = 1 WHERE id = ?").bind(org).run();
    const told = await read(inside.token);
    const hidden = await read(stranger.token);
    const missing = await call(`/v1/changes?project=${makeId("prj", ulid())}`, {
      token: stranger.token,
    });
    expect([told.status, told.body["code"], told.body["detail"]]).toEqual([
      403,
      "auth.forbidden",
      "Refused: org-suspended.",
    ]);
    expect([hidden.status, hidden.body["code"]]).toEqual([404, "resource.not_found"]);
    expect(blank(hidden.body)).toEqual(blank(missing.body));
  });
});

/** A tool call's answer: its structured content, or a failure's problem from the text mirror. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(await mcp(token, "tools/call", { name, arguments: args }, name));
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return {
    isError: result["isError"] === true,
    body: result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined),
  };
}

describe("[authz.mcp] the same policy over MCP", () => {
  it("[authz.mcp] an agent's tool call on a change in another org's private project answers exactly REST's 404 of a change that does not exist", async () => {
    const foreign = await elsewhere();
    const c = await changeUnderTest(foreign);
    ok(await c.declare());
    const agent = await tokenFor(await seedAgent());
    const missing = makeId("chg", ulid());

    const hidden = await tool(agent, "change", { changeId: c.changeId });
    const absent = await tool(agent, "change", { changeId: missing });
    const rest = await call(`/v1/changes/${c.changeId}`, { token: agent });

    expect(hidden.isError).toBe(true);
    expect(hidden.body).toMatchObject({ status: 404, code: "change.not_found" });
    expect(blank(hidden.body, c.changeId)).toEqual(blank(absent.body, missing));
    expect(blank(hidden.body)).toEqual(blank(rest.body));
    // The owning org's own agent reads it, so the 404 above is the policy's, not a missing change's.
    const own = await tokenFor(await seedForeignAgent({ projectId: foreign }));
    expect((await tool(own, "change", { changeId: c.changeId })).body).toMatchObject({
      id: c.changeId,
    });
  });

  it("[authz.mcp] a bearer the gate refuses is 401 at the MCP endpoint, never served as anonymous", async () => {
    const token = await tokenFor(await seedAgent());
    const forged = `${token.slice(0, token.lastIndexOf(".") + 1)}AAAA`;
    for (const bad of [forged, "not-a-session"]) {
      const response = await mcp(bad, "tools/list");
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
    expect((await mcp(token, "tools/list")).status).toBe(200);
  });
});

describe("[authz.r6] a project by its org's name and its own, and who the user is", () => {
  it("[authz.r6] answers the project in any case, with the reader's role for a member and none for an outsider of a public project", async () => {
    const p = await project();
    const reader = await member();
    const stranger = await outsider();
    const path = `/v1/namespaces/POOL/projects/${p.projectId.toUpperCase()}`;

    const inside = await call(path, { token: reader.token });
    const hidden = await call(path, { token: stranger.token });
    await p.open();
    const outside = await call(path, { token: stranger.token });

    expect(inside).toEqual({
      status: 200,
      body: {
        id: p.projectId,
        namespace: { handle: "pool", kind: "org" },
        name: p.projectId.toLowerCase(),
        visibility: "private",
        viewer: { role: "member" },
      },
    });
    expect([hidden.status, hidden.body["code"]]).toEqual([404, "resource.not_found"]);
    expect(outside).toEqual({
      status: 200,
      body: {
        id: p.projectId,
        namespace: { handle: "pool", kind: "org" },
        name: p.projectId.toLowerCase(),
        visibility: "public",
      },
    });
  });

  it("[authz.r6] GET /v1/users/me answers the user's handle, its own namespace and its orgs with its role in each", async () => {
    const user = await seedUser(uniqueHandle("me"), { role: "maintainer" });
    const alone = await seedUser(uniqueHandle("alone-me"), { role: null });
    expect(await call("/v1/users/me", { token: user.token })).toEqual({
      status: 200,
      body: {
        userId: user.userId,
        handle: user.handle,
        namespace: { handle: user.handle, kind: "user" },
        orgs: [{ id: POOL_ORG, name: "pool", role: "maintainer" }],
      },
    });
    expect(await call("/v1/users/me", { token: alone.token })).toEqual({
      status: 200,
      body: {
        userId: alone.userId,
        handle: alone.handle,
        namespace: { handle: alone.handle, kind: "user" },
        orgs: [],
      },
    });
  });
});

describe("[authz.create-project] creating a project in an org", () => {
  const SOURCE = "fixture-forge-lite";
  const app = () => {
    const { app: built } = makeIsolate(
      env,
      isolateLayer(env, { projects: makeProjectsMemory({ sources: [SOURCE] }).layer }),
    );
    const via: Fetch = async (url, init) => built.fetch(new Request(url, init), env);
    return via;
  };
  const create = (via: Fetch, token: string, name: string, org = "pool") =>
    call("/v1/projects", {
      via,
      token,
      method: "POST",
      key: `create-${ulid()}`,
      body: { namespace: org, name, source: SOURCE },
    });

  it("[authz.create-project] a member creates one in its org; the same name in another case is taken; an outsider lacks the role", async () => {
    const via = app();
    const user = await member();
    const name = uniqueHandle("made");

    const made = await create(via, user.token, name);
    const again = await create(via, user.token, name.toUpperCase());
    const stranger = await create(via, (await outsider()).token, uniqueHandle("theirs"));

    expect(made).toEqual({
      status: 201,
      body: {
        id: expect.stringMatching(/^prj_/),
        namespace: { handle: "pool", kind: "org" },
        name,
        visibility: "private",
        createdAt: expect.any(String),
        viewer: { role: "member" },
      },
    });
    expect([again.status, again.body["code"]]).toEqual([409, "project.name_taken"]);
    // An org is no secret: an outsider sees it and is refused for want of a role in it.
    expect([stranger.status, stranger.body["code"], stranger.body["detail"]]).toEqual([
      403,
      "auth.forbidden",
      "Refused: role.",
    ]);
    // An org that does not exist reads as missing.
    const nowhere = await create(via, user.token, uniqueHandle("lost"), uniqueHandle("no-org"));
    expect([nowhere.status, nowhere.body["code"]]).toEqual([404, "resource.not_found"]);
  });
});
