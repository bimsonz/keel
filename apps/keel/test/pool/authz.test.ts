// The one authorization policy as the doorway answers it, through the real
// gate, handlers and DOs, over REST and MCP: who sees a project, what each
// audience reads, what agents and users may each do, and how a refusal reads.
// Projects are real Project DOs placed in an org; the repo reads and project
// creation run over in-memory code and projects.
import { env } from "cloudflare:workers";
import { projectRepos } from "@keeltown/core/application/integration";
import { LEASE_TTL_MS, Proposition } from "@keeltown/core/domain/coordination";
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
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { changeUnderTest, ok, refusal } from "./change-harness.ts";
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
      body: { namespace: org, name, source: { kind: "template", name: SOURCE } },
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

/** A move on a change under a lease, over REST, as an agent sends one. */
async function move(
  token: string,
  path: string,
  lease: string | undefined,
  key: string,
  options: { readonly ifMatch?: string; readonly body?: object } = {},
) {
  const response = await worker(`${BASE}/v1${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(lease === undefined ? {} : { "keel-lease": lease }),
      "idempotency-key": key,
      ...(options.ifMatch === undefined ? {} : { "if-match": options.ifMatch }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json<Record<string, unknown>>();
  return {
    status: response.status,
    code: body["code"],
    detail: body["detail"],
    nextActions: body["nextActions"],
    lease: Object(body["result"]).lease?.id,
  };
}

const PER_SESSION = Schema.encodeSync(Proposition)(
  Schema.decodeUnknownSync(Proposition)({
    subject: "authz.permission-evaluation",
    predicate: "freshness",
    relation: "is",
    value: "per-session",
  }),
);

describe("[authz.lease-foreign] a change's lease moves it only from the change's own project", () => {
  it("[authz.lease-foreign] an agent of another org holding a change's id and lease is answered not found on revise, rely, rebase and submit, over REST and MCP, and the change is untouched; its own project's agents move it, after an adoption too", async () => {
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const declared = ok(await c.declare("declare-1")).change.lease.id;
    const sha = await c.push();
    const own = await tokenFor(await seedAgent({ projectId, id: c.agentId }));
    const ofProject = await seedAgent({ projectId });
    const colleague = await tokenFor(ofProject);
    const foreigner = await tokenFor(await seedForeignAgent());
    // A refusal that renewed the lease would move its time: the clock moves first, so one would show.
    c.clock.advance(60_000);

    /** Every move the foreigner can make under `lease`, each as [status, code]. */
    const foreign = async (lease: string, revision: number, round: string) => {
      const ifMatch = `"${revision}"`;
      const moves = await Promise.all([
        move(foreigner, `/changes/${c.changeId}/revisions`, lease, `${round}-revise-key`, {
          ifMatch,
          body: { goal: "Rewritten by an agent of another org" },
        }),
        move(foreigner, `/changes/${c.changeId}/premises`, lease, `${round}-rely-key`, {
          body: { premise: PER_SESSION },
        }),
        move(foreigner, `/changes/${c.changeId}/rebase`, lease, `${round}-rebase-key`),
        move(foreigner, "/submissions", lease, `${round}-submit-key`, {
          body: { changeId: c.changeId, commitSha: sha },
        }),
      ]);
      const viaTool = await tool(foreigner, "revise", {
        changeId: c.changeId,
        "keel-lease": lease,
        "idempotency-key": `${round}-revise-mcp`,
        "if-match": String(revision),
        goal: "Rewritten by an agent of another org",
      });
      return [
        ...moves.map((answer) => [answer.status, answer.code]),
        [Object(viaTool.body).status, Object(viaTool.body).code],
      ];
    };
    const NOT_FOUND = Array.from({ length: 5 }, () => [404, "change.not_found"]);

    const before = { log: await c.log(), change: await c.current() };
    const first = await foreign(declared, 1, "f1");
    // The change's own object refuses another project too, for the one move no doorway reaches it with.
    const distinguished = decodeExit(
      ChangeCodecs.distinguish,
      await c.stub.distinguish({
        agentId: c.agentId,
        projectId: makeId("prj", ulid()),
        leaseId: declared,
        decisionId: makeId("dec", ulid()),
        distinction: "A decision of this change's project does not govern it",
        idempotencyKey: "f1-distinguish-key",
      }),
    );
    const untouched = { log: await c.log(), change: await c.current() };

    // The change's own agent moves it under the lease, and another agent of its project after adopting it.
    const revised = await move(own, `/changes/${c.changeId}/revisions`, declared, "c-revise-key", {
      ifMatch: '"1"',
      body: { goal: "Cache permission lookups per request, in its own agent's words" },
    });
    c.clock.advance(LEASE_TTL_MS);
    const adopted = await move(colleague, `/changes/${c.changeId}/adopt`, undefined, "c-adopt-key");
    const second = await foreign(String(adopted.lease), 2, "f2");
    const after = await c.current();
    const lease = String(adopted.lease);
    const relied = await move(colleague, `/changes/${c.changeId}/premises`, lease, "c-rely-key", {
      body: { premise: PER_SESSION },
    });
    const ownDistinction = decodeExit(
      ChangeCodecs.distinguish,
      await c.stub.distinguish({
        agentId: ofProject.agent.id,
        projectId,
        leaseId: lease,
        decisionId: makeId("dec", ulid()),
        distinction: "A decision of another subject does not govern it",
        idempotencyKey: "c-distinguish-key",
      }),
    );
    // Trunk moves on, so the change's own project rebases it onto trunk's head, then submits it.
    const trunk = projectRepos(projectId).trunk;
    c.trunks.heads.set(
      projectId,
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* CodeHost).create(trunk);
          return yield* c.code.fixture.commit(trunk, "refs/heads/main", {
            "README.md": "landed\n",
          });
        }).pipe(Effect.provide(c.code.layer)),
      ),
    );
    const rebased = await move(colleague, `/changes/${c.changeId}/rebase`, lease, "c-rebase-key");
    const submitted = await move(colleague, "/submissions", lease, "c-submit-key", {
      body: { changeId: c.changeId, commitSha: sha },
    });

    expect(first).toEqual(NOT_FOUND);
    expect(refusal(distinguished)).toContain("ChangeNotFound");
    expect(untouched).toEqual(before);
    expect([revised.status, adopted.status]).toEqual([200, 200]);
    expect(second).toEqual(NOT_FOUND);
    expect(after.intent.goal).toBe(
      "Cache permission lookups per request, in its own agent's words",
    );
    expect([relied.status, refusal(ownDistinction), rebased.status, submitted.status]).toEqual([
      200,
      "success",
      200,
      202,
    ]);
  });
});

describe("[authz.lease-holder] only the agent holding a change acts under its lease", () => {
  it("[authz.lease-holder] another agent of the change's project, holding its id and lease, is 409 change.held_by_other naming the holder, with when the lease lapses and adopt to call then, on revise, rely, rebase, submit, commit and abandon over REST, revise over MCP, and distinguish and a fresh workspace token at the change's object; an agent of another org is still 404; nothing moves; once the colleague adopts the change it moves it, and its former holder is told who holds it now, whichever lease it sends", async () => {
    const projectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const declared = ok(await c.declare("declare-1")).change.lease;
    const sha = await c.push();
    const holder = await tokenFor(
      await seedAgent({ projectId, id: c.agentId, name: "cache-holder" }),
    );
    const ofProject = await seedAgent({ projectId, name: "cache-colleague" });
    const colleague = await tokenFor(ofProject);
    const foreigner = await tokenFor(await seedForeignAgent());
    // A refusal that renewed the lease would move its time: the clock moves first, so one would show.
    c.clock.advance(60_000);

    /** Every move `token` can make on the change under `lease`, each answered whole. */
    const moves = async (token: string, lease: string, revision: number, round: string) => {
      const answers = await Promise.all([
        move(token, `/changes/${c.changeId}/revisions`, lease, `${round}-revise-key`, {
          ifMatch: `"${revision}"`,
          body: { goal: "Rewritten by an agent that does not hold the change" },
        }),
        move(token, `/changes/${c.changeId}/premises`, lease, `${round}-rely-key`, {
          body: { premise: PER_SESSION },
        }),
        move(token, `/changes/${c.changeId}/rebase`, lease, `${round}-rebase-key`),
        move(token, "/submissions", lease, `${round}-submit-key`, {
          body: { changeId: c.changeId, commitSha: sha },
        }),
        move(token, `/changes/${c.changeId}/commits`, lease, `${round}-commit-key`, {
          body: {
            expectedHead: sha,
            message: "Rewrite a",
            edits: [{ path: "a.txt", content: "b" }],
          },
        }),
        move(token, `/changes/${c.changeId}/abandon`, lease, `${round}-abandon-key`, { body: {} }),
      ]);
      const viaTool = await tool(token, "revise", {
        changeId: c.changeId,
        "keel-lease": lease,
        "idempotency-key": `${round}-revise-mcp`,
        "if-match": String(revision),
        goal: "Rewritten by an agent that does not hold the change",
      });
      return [...answers, Object(viaTool.body)];
    };
    /** Distinguish and a fresh workspace token, at the change's own object, which no doorway reaches with another agent. */
    const atObject = async (agentId: string, lease: string, round: string) => [
      refusal(
        decodeExit(
          ChangeCodecs.distinguish,
          await c.stub.distinguish({
            agentId,
            projectId,
            leaseId: lease,
            decisionId: makeId("dec", ulid()),
            distinction: "A decision of this change's project does not govern it",
            idempotencyKey: `${round}-distinguish-key`,
          }),
        ),
      ),
      refusal(
        decodeExit(
          ChangeCodecs.refreshWorkspace,
          await c.stub.refreshWorkspace({ agentId, projectId, leaseId: lease }),
        ),
      ),
    ];
    const heldBy = (name: string, lapsesAt: number) => ({
      status: 409,
      code: "change.held_by_other",
      detail: expect.stringContaining(
        `held by ${name} under a lease that lapses at ${new Date(lapsesAt).toISOString()}`,
      ),
      nextActions: [
        { kind: "wait", title: expect.any(String), args: { lapsesAt } },
        {
          kind: "call",
          title: expect.any(String),
          operationId: "adopt",
          args: { changeId: c.changeId },
        },
      ],
    });

    const before = { log: await c.log(), change: await c.current() };
    const told = await moves(colleague, declared.id, 1, "c1");
    const toldAtObject = await atObject(ofProject.agent.id, declared.id, "c1");
    const fromOtherOrg = await Promise.all([
      move(foreigner, `/changes/${c.changeId}/revisions`, declared.id, "f1-revise-key", {
        ifMatch: '"1"',
        body: { goal: "Rewritten by an agent of another org" },
      }),
      move(foreigner, `/changes/${c.changeId}/commits`, declared.id, "f1-commit-key", {
        body: { expectedHead: sha, message: "Rewrite a", edits: [{ path: "a.txt", content: "b" }] },
      }),
      move(foreigner, `/changes/${c.changeId}/abandon`, declared.id, "f1-abandon-key", {
        body: {},
      }),
    ]);
    const untouched = { log: await c.log(), change: await c.current() };

    // The colleague adopts the change once its lease lapses, and moves it under its own lease.
    c.clock.advance(LEASE_TTL_MS);
    const adopted = await move(colleague, `/changes/${c.changeId}/adopt`, undefined, "c-adopt-key");
    const lease = String(adopted.lease);
    const revised = await move(
      colleague,
      `/changes/${c.changeId}/revisions`,
      lease,
      "c-revise-key",
      {
        ifMatch: '"1"',
        body: { goal: "Cache permission lookups per request, as its adopter put it" },
      },
    );
    const adoptedLease = (await c.current()).lease;
    const formerOld = await move(
      holder,
      `/changes/${c.changeId}/revisions`,
      declared.id,
      "h-old-key",
      {
        ifMatch: '"2"',
        body: { goal: "Rewritten by the change's former holder" },
      },
    );
    const formerNew = await move(holder, `/changes/${c.changeId}/revisions`, lease, "h-new-key", {
      ifMatch: '"2"',
      body: { goal: "Rewritten by the change's former holder" },
    });
    const after = await c.current();

    const lapses = declared.renewedAt + LEASE_TTL_MS;
    expect(told).toEqual([
      ...Array.from({ length: 6 }, () => expect.objectContaining(heldBy("cache-holder", lapses))),
      expect.objectContaining({ status: 409, code: "change.held_by_other" }),
    ]);
    expect(toldAtObject.map((answer) => answer.includes('"_tag":"ChangeHeldByOther"'))).toEqual([
      true,
      true,
    ]);
    expect(fromOtherOrg.map((answer) => [answer.status, answer.code])).toEqual(
      Array.from({ length: 3 }, () => [404, "change.not_found"]),
    );
    expect(untouched).toEqual(before);
    expect([adopted.status, revised.status]).toEqual([200, 200]);
    const adopterLapses = adoptedLease.renewedAt + LEASE_TTL_MS;
    expect(formerOld).toMatchObject(heldBy("cache-colleague", adopterLapses));
    expect(formerNew).toMatchObject(heldBy("cache-colleague", adopterLapses));
    expect(after.intent.goal).toBe("Cache permission lookups per request, as its adopter put it");
  });
});
