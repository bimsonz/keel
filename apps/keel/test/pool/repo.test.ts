import { env } from "cloudflare:workers";
import { projectRepos } from "@keeltown/core/application/integration";
import { type CommitSha, ProjectId } from "@keeltown/core/kernel";
import { CodeHost, Trunks } from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeLanesMemory,
  makeProjectsMemory,
  makeTrunksMemory,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  BASE,
  type Fetch,
  mcp,
  mcpResult,
  seedAgent,
  seedForeignAgent,
  tokenFor,
  worker,
} from "./helpers.ts";

/**
 * The repo read API through the real doorway and auth gate: its routes admit a
 * caller with no token, yet read a token that is presented. Trunks and settings
 * are in memory; agents and tokens are real. The trunk's and the lanes'
 * own routes go through the same doorway.
 */
const project = Schema.decodeUnknownSync(ProjectId);
const PRIVATE = project("prj_25R7GR504NN2N2MB7JTCFBPPQ8");
const PUBLIC = project("prj_7VDSYA2DEW8R8GHT98W18TZKVN");

async function repoApp() {
  const codeHost = makeCodeHostMemory();
  const projects = makeProjectsMemory();
  const trunks = makeTrunksMemory();
  const lanes = makeLanesMemory();
  const heads = new Map<ProjectId, CommitSha>();
  for (const [projectId, visibility] of [
    [PRIVATE, "private"],
    [PUBLIC, "public"],
  ] as const) {
    projects.setSettings(projectId, {
      protectedPaths: [],
      maxBatchSize: 1,
      verification: "required",
      visibility,
    });
    const trunk = projectRepos(projectId).trunk;
    const head = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* CodeHost).create(trunk);
        const first = yield* codeHost.fixture.commit(trunk, "refs/heads/main", {
          "README.md": "# hi\n",
          "src/main.ts": "export const main = 1;\n",
        });
        yield* (yield* Trunks).initialize(projectId, first, "seed", { kind: "empty" });
        return first;
      }).pipe(Effect.provide(Layer.merge(codeHost.layer, trunks.layer))),
    );
    heads.set(projectId, head);
    lanes.hold(projectId, { queued: 2, inFlight: 1 });
  }
  const { app } = makeIsolate(
    env,
    isolateLayer(env, {
      codeHost: codeHost.layer,
      projects: projects.layer,
      trunks: trunks.layer,
      lanes: lanes.layer,
    }),
  );
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return { via, heads };
}

const tree = (via: Fetch, projectId: string, authorization?: string) =>
  via(`${BASE}/v1/projects/${projectId}/repo/tree`, {
    headers: authorization === undefined ? {} : { authorization },
  }).then(async (r) => ({ status: r.status, body: await r.json<{ code?: string }>() }));

const lanesOf = (via: Fetch, projectId: string, authorization?: string) =>
  via(`${BASE}/v1/projects/${projectId}/lanes`, {
    headers: authorization === undefined ? {} : { authorization },
  }).then(async (r) => ({ status: r.status, body: await r.json<Record<string, unknown>>() }));

/** The one page a project's lanes are, as `repoApp` holds them. */
const page = (projectId: ProjectId) => ({
  status: 200,
  body: { items: [{ id: `lane:${projectId}:main`, projectId, queued: 2, inFlight: 1 }] },
});

const trunkOf = (via: Fetch, projectId: string, authorization?: string) =>
  via(`${BASE}/v1/projects/${projectId}/trunk`, {
    headers: authorization === undefined ? {} : { authorization },
  }).then(async (r) => ({ status: r.status, body: await r.json<Record<string, unknown>>() }));

describe("the repo read API's doorway", () => {
  it("[repo.http] no token reads only a public project; a presented token is read, its agent's own project opens, a bad one is refused", async () => {
    const { via } = await repoApp();
    const own = await tokenFor(await seedAgent({ projectId: PRIVATE }));
    const sibling = await tokenFor(await seedAgent({ projectId: PUBLIC }));
    const other = await tokenFor(await seedForeignAgent());

    expect(await tree(via, PUBLIC)).toMatchObject({ status: 200 });
    expect(await tree(via, PRIVATE)).toMatchObject({
      status: 404,
      body: { code: "resource.not_found" },
    });
    expect(await tree(via, PRIVATE, `Bearer ${own}`)).toMatchObject({ status: 200 });
    expect(await tree(via, PRIVATE, `Bearer ${other}`)).toMatchObject({
      status: 404,
      body: { code: "resource.not_found" },
    });
    // Another project of its own org is refused by name; another org's private project reads as missing.
    expect(await tree(via, PRIVATE, `Bearer ${sibling}`)).toMatchObject({
      status: 403,
      body: { code: "auth.forbidden", detail: "Refused: foreign-project." },
    });
    expect(await tree(via, PUBLIC, `Bearer ${other}`)).toMatchObject({ status: 200 });
    for (const bad of ["Bearer not-a-token", "Basic YTpi"])
      expect(await tree(via, PUBLIC, bad)).toMatchObject({
        status: 401,
        body: { code: "auth.invalid_token" },
      });
  });

  it("[cache.after-gate] what the project's own agent read, and the cache now keeps, is still refused to a stranger and to no token", async () => {
    const { via, heads } = await repoApp();
    const own = await tokenFor(await seedAgent({ projectId: PRIVATE }));
    const other = await tokenFor(await seedForeignAgent());
    const head = heads.get(PRIVATE);
    const read = (path: string, authorization?: string) =>
      via(`${BASE}/v1/projects/${PRIVATE}/repo/${path}`, {
        headers: authorization === undefined ? {} : { authorization },
      }).then(async (r) => ({ status: r.status, body: await r.json<{ code?: string }>() }));
    const missing = { status: 404, body: { code: "resource.not_found" } };

    for (const path of [`blob?ref=${head}&path=README.md`, `commits/${head}`, `tree?ref=${head}`]) {
      expect(await read(path, `Bearer ${own}`)).toMatchObject({ status: 200 });
      expect(await read(path, `Bearer ${own}`)).toMatchObject({ status: 200 });
      expect(await read(path, `Bearer ${other}`)).toMatchObject(missing);
      expect(await read(path)).toMatchObject(missing);
    }
  });

  it("[views.trunk.wired] the trunk's route answers through the real doorway: anyone reads a public project's trunk, a private one's is read by its own agent, and a stranger is told the project is missing", async () => {
    const { via, heads } = await repoApp();
    const own = await tokenFor(await seedAgent({ projectId: PRIVATE }));
    // Seeding an agent of a project is what places it in its org: without one the public project reads as missing.
    await seedAgent({ projectId: PUBLIC });
    const other = await tokenFor(await seedForeignAgent());
    const open = await trunkOf(via, PUBLIC);
    expect(open).toMatchObject({
      status: 200,
      body: { projectId: PUBLIC, head: heads.get(PUBLIC), frozen: false },
    });
    expect(Object.keys(open.body).toSorted()).toEqual([
      "advancedAt",
      "frozen",
      "head",
      "projectId",
    ]);
    expect(new Date(String(open.body["advancedAt"])).toISOString()).toBe(open.body["advancedAt"]);
    expect(await trunkOf(via, PRIVATE, `Bearer ${own}`)).toMatchObject({
      status: 200,
      body: { projectId: PRIVATE, head: heads.get(PRIVATE), frozen: false },
    });
    for (const authorization of [undefined, `Bearer ${other}`])
      expect(await trunkOf(via, PRIVATE, authorization)).toMatchObject({
        status: 404,
        body: { code: "resource.not_found" },
      });
  });

  it("[views.lanes.wired] the lanes' route answers through the real doorway, decided on the project its path names: anyone reads a public project's lanes, a private one's are read by its own agent, and a stranger is told the project is missing", async () => {
    const { via } = await repoApp();
    const own = await tokenFor(await seedAgent({ projectId: PRIVATE }));
    // Seeding an agent of a project is what places it in its org: without one the public project reads as missing.
    await seedAgent({ projectId: PUBLIC });
    const other = await tokenFor(await seedForeignAgent());
    expect(await lanesOf(via, PUBLIC)).toEqual(page(PUBLIC));
    expect(await lanesOf(via, PRIVATE, `Bearer ${own}`)).toEqual(page(PRIVATE));
    // A foreign agent asking for a public project is decided on that project, not on its own.
    expect(await lanesOf(via, PUBLIC, `Bearer ${other}`)).toEqual(page(PUBLIC));
    for (const authorization of [undefined, `Bearer ${other}`])
      expect(await lanesOf(via, PRIVATE, authorization)).toMatchObject({
        status: 404,
        body: { code: "resource.not_found" },
      });
  });

  it("[views.candidate-removed] a candidate's own route is no operation: its path answers 404 as any unknown path does", async () => {
    const { via } = await repoApp();
    const own = await tokenFor(await seedAgent({ projectId: PRIVATE }));
    const answers = await Promise.all(
      ["/candidates/cnd_01JZ8PT2C4E6G8J0M2N4Q6S8V0", "/no-such-operation"].map((path) =>
        via(`${BASE}/v1${path}`, { headers: { authorization: `Bearer ${own}` } }).then(
          async (r) => [r.status, (await r.json<{ code?: string }>()).code],
        ),
      ),
    );
    expect(answers).toEqual([
      [404, "resource.not_found"],
      [404, "resource.not_found"],
    ]);
  });

  it("[repo.http-exchange] the anonymous-only token exchange still ignores an Authorization header", async () => {
    const seeded = await seedAgent();
    const response = await worker(`${BASE}/v1/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer stale",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: seeded.clientId,
        client_secret: seeded.clientSecret,
      }),
    });
    expect(response.status).toBe(200);
  });
});

/** A body as both doors answer it, the problem's request id left out: each request has its own. */
const answer = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));

/** One repo read over REST, as an agent's token presents it. */
const restRead = async (
  via: Fetch,
  token: string,
  read: "tree" | "blob",
  query: Record<string, string>,
) => {
  const response = await via(
    `${BASE}/v1/projects/${PRIVATE}/repo/${read}?${new URLSearchParams(query).toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { status: response.status, body: answer(await response.json()) };
};

/**
 * One of Keel's MCP tools, called as an agent's client calls it: refused or
 * not, its answer as its text says it, and its structured content, which a
 * refusal has none of.
 */
const toolRead = async (via: Fetch, token: string, name: string, args: Record<string, string>) => {
  const result = await mcpResult(
    await mcp(token, "tools/call", { name, arguments: args }, name, via),
  );
  const content: unknown = result["content"];
  const text = Array.isArray(content) ? String(Object(content[0])["text"]) : "{}";
  return {
    refused: result["isError"] === true,
    body: answer(JSON.parse(text)),
    structured: result["structuredContent"],
  };
};

describe("the repo reads through Keel's MCP", () => {
  it("[mcp.read] an agent lists trunk's tree and reads a file through Keel's tools, each the answer REST gives, and another project's agent is refused there as REST refuses it", async () => {
    const { via, heads } = await repoApp();
    const own = await tokenFor(await seedAgent({ projectId: PRIVATE }));
    const sibling = await tokenFor(await seedAgent({ projectId: PUBLIC }));
    const other = await tokenFor(await seedForeignAgent());
    const head = String(heads.get(PRIVATE));
    const reads: readonly (readonly [string, "tree" | "blob", Record<string, string>])[] = [
      ["Repo_getTree", "tree", {}],
      ["Repo_getTree", "tree", { ref: head, path: "src" }],
      ["Repo_getBlob", "blob", { path: "src/main.ts" }],
    ];

    expect(await toolRead(via, own, "Repo_getTree", { projectId: PRIVATE })).toMatchObject({
      refused: false,
      body: {
        commit: head,
        path: "",
        entries: [
          { name: "README.md", kind: "blob" },
          { name: "src", kind: "tree" },
        ],
      },
    });
    expect(
      await toolRead(via, own, "Repo_getBlob", { projectId: PRIVATE, path: "src/main.ts" }),
    ).toMatchObject({
      refused: false,
      body: { commit: head, path: "src/main.ts", content: "export const main = 1;\n" },
    });
    for (const [name, read, query] of reads) {
      const rest = await restRead(via, own, read, query);
      expect(rest.status).toBe(200);
      expect(await toolRead(via, own, name, { projectId: PRIVATE, ...query })).toEqual({
        refused: false,
        body: rest.body,
        structured: rest.body,
      });
    }

    // Another project of its own org is refused by name, and another org's agent finds no project, at both doors.
    for (const [token, status] of [
      [sibling, 403],
      [other, 404],
    ] as const)
      for (const [name, read, query] of reads) {
        const rest = await restRead(via, token, read, query);
        expect(rest.status).toBe(status);
        expect(await toolRead(via, token, name, { projectId: PRIVATE, ...query })).toEqual({
          refused: true,
          body: rest.body,
          structured: undefined,
        });
      }
  });
});
