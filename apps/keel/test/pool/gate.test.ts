// The gate before its user branch: a Better Auth session is not yet a
// principal, so a signed-in browser reads exactly what an anonymous visitor
// reads. Its cookie rides along on every same-origin call, so it must neither
// break a public page nor open a private one.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { CodeHost } from "@keeltown/core/ports";
import { makeId } from "@keeltown/core/kernel";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { backbone } from "../../src/composition/do.ts";
import { decodeExit, ProjectCodecs } from "../../src/rpc/index.ts";
import { Authenticator, caller, Jar } from "./auth-harness.ts";
import { ok } from "./change-harness.ts";
import { BASE, drainAfter, drainOutbox, seedAgent, tokenFor, worker } from "./helpers.ts";

const SOURCE = { namespace: "keel-core", name: "gate-app" };
const site = caller((request) => exports.default.fetch(request));

/** A project on in-memory code, trunk and pool; public when `visibility` says so. */
async function project(visibility: "public" | "private") {
  const projectId = makeId("prj", ulid());
  const stub = drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));
  const code = makeCodeHostMemory();
  await runInDurableObject(stub, (instance: ProjectDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          code.layer,
          makeTrunksMemory().layer,
          makeWorkspacePoolMemory().layer,
        ),
      ),
    );
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(SOURCE);
      yield* (yield* CodeHostFixture).commit(SOURCE, "refs/heads/main", { "a.txt": "a" });
    }).pipe(Effect.provide(code.layer)),
  );
  ok(
    decodeExit(
      ProjectCodecs.createProject,
      await stub.createProject({
        projectId,
        name: "Gate app",
        source: SOURCE.name,
        by: makeId("agt", ulid()),
        idempotencyKey: "create-1",
        fingerprint: "body-1",
      }),
    ),
  );
  await drainOutbox(stub);
  if (visibility === "public") {
    const operator = await tokenFor(await seedAgent({}, ["operator"]));
    const put = await worker(`${BASE}/v1/projects/${projectId}/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: [], maxBatchSize: 1, visibility: "public" }),
    });
    if (put.status !== 200) throw new Error(`making ${projectId} public: ${await put.text()}`);
    await drainOutbox(stub);
  }
  return projectId;
}

/** A signed-in browser: a passkey-first user's session cookie, sent as the page sends it. */
async function signedIn(handle: string) {
  const jar = new Jar();
  const device = new Authenticator();
  const options = await site(`/passkey/generate-register-options?context=${handle}`, { jar });
  const registered = await site("/passkey/verify-registration", {
    body: { response: await device.create(options.json.challenge), createSession: true },
    jar,
  });
  expect(registered.status).toBe(200);
  return jar;
}

/** A GET through keel.town's entry, with the browser's cookies or with none. */
const read = (path: string, jar?: Jar) =>
  worker(`${BASE}${path}`, jar === undefined ? {} : { headers: { cookie: jar.header() } });

describe("[gate.session-anonymous] a session reads exactly what an anonymous visitor reads", () => {
  it("[gate.session-anonymous] a public project's activity, no private one, no instance-wide feed and no agent's operation", async () => {
    const jar = await signedIn("gina");
    const open = await project("public");
    const closed = await project("private");
    const paths = [
      `/v1/events?project=${open}`,
      `/v1/changes?project=${open}`,
      `/v1/events?project=${closed}`,
      `/v1/changes?project=${closed}`,
      "/v1/events",
      "/v1/agents/me",
    ];
    const statuses = async (browser?: Jar) =>
      Promise.all(paths.map(async (path) => (await read(path, browser)).status));
    const anonymous = await statuses();
    expect(anonymous).toEqual([200, 200, 404, 404, 401, 401]);
    expect(await statuses(jar)).toEqual(anonymous);
  });
});
