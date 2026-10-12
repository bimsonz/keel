import { env } from "cloudflare:workers";
import { projectRepos } from "@keeltown/core/application/integration";
import { ProjectId } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import { makeCodeHostMemory, makeProjectsMemory } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { BASE, type Fetch, seedAgent, seedForeignAgent, tokenFor, worker } from "./helpers.ts";

/**
 * The repo read API through the real doorway and auth gate: its routes admit a
 * caller with no token, yet read a token that is presented. Trunks and settings
 * are in memory; agents and tokens are real.
 */
const project = Schema.decodeUnknownSync(ProjectId);
const PRIVATE = project("prj_25R7GR504NN2N2MB7JTCFBPPQ8");
const PUBLIC = project("prj_7VDSYA2DEW8R8GHT98W18TZKVN");

async function repoApp() {
  const codeHost = makeCodeHostMemory();
  const projects = makeProjectsMemory();
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
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* CodeHost).create(trunk);
        yield* codeHost.fixture.commit(trunk, "refs/heads/main", { "README.md": "# hi\n" });
      }).pipe(Effect.provide(codeHost.layer)),
    );
  }
  const { app } = makeIsolate(
    env,
    isolateLayer(env, { codeHost: codeHost.layer, projects: projects.layer }),
  );
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return via;
}

const tree = (via: Fetch, projectId: string, authorization?: string) =>
  via(`${BASE}/v1/projects/${projectId}/repo/tree`, {
    headers: authorization === undefined ? {} : { authorization },
  }).then(async (r) => ({ status: r.status, body: await r.json<{ code?: string }>() }));

describe("the repo read API's doorway", () => {
  it("[repo.http] no token reads only a public project; a presented token is read, its agent's own project opens, a bad one is refused", async () => {
    const via = await repoApp();
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
