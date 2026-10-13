// A namespace's credentials and a project's deploy targets, through the real
// gate, policy, handlers, credential store, Project DO and Cloudflare adapter,
// on the app as the isolate composes it. Cloudflare's API is the one thing
// doubled: `fetch` is spied on in this isolate, which is where the adapter
// asks it, and every request to api.cloudflare.com is answered here and
// recorded; anything else it is asked for fails the test.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { namespaceAddress } from "@keeltown/core/application/coordination";
import { makeId, type NamespaceId, type ProjectId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PORTS } from "@keeltown/testing";
import { Effect } from "effect";
import { CLOUDFLARE_API } from "../../src/adapters/driven/deploy/cloudflare-api.ts";
import { DeployTargetsRpc } from "../../src/adapters/driven/do-rpc/deploy-targets.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  type Fetch,
  OTHER_ORG,
  placeProject,
  POOL_ORG,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
} from "./helpers.ts";

const isolate = makeIsolate(env, isolateLayer(env));
/** The app as the isolate composes it, run in this isolate, so the spy on `fetch` is the one it calls. */
const app: Fetch = async (url, init) =>
  isolate.app.fetch(new Request(url, init), env, createExecutionContext());

const ACCOUNT = "0123456789abcdef0123456789abcdef";

interface Answered {
  readonly status: number;
  /** The body exactly as it left Keel. */
  readonly text: string;
  readonly json: Record<string, unknown>;
}

async function call(
  path: string,
  options: { readonly token: string; readonly method?: string; readonly body?: object },
): Promise<Answered> {
  const headers = new Headers({ authorization: `Bearer ${options.token}` });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await app(`${BASE}/v1${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: text === "" ? {} : JSON.parse(text) };
}

/** A namespace's object and a project's, drained after the case: each commits events. */
const drainNamespace = (namespace: NamespaceId) =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(namespace))));
const drainProject = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

/** A private project of `org`, held by its Project DO. */
async function freshProject(org: NamespaceId = POOL_ORG): Promise<ProjectId> {
  const projectId = makeId("prj", ulid());
  await placeProject(projectId, org);
  await establishProject(projectId);
  drainProject(projectId);
  return projectId;
}

const freshToken = () => `cf-token-${crypto.randomUUID()}`;

/** Stores a credential as `token`'s owner of the namespace `handle`, and answers its id. */
async function stored(token: string, handle: string, secret = freshToken()): Promise<string> {
  const created = await call(`/namespaces/${handle}/credentials`, {
    token,
    method: "POST",
    body: { label: "ci", provider: "cloudflare", secret },
  });
  expect(created.status).toBe(201);
  return String(created.json["id"]);
}

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

/** Cloudflare's API, doubled: each request recorded, each answered by `answer`; any other host fails. */
function cloudflare(answer: (request: Request) => Response) {
  const asked: Asked[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${CLOUDFLARE_API}/`))
      throw new Error(`no fetch to ${request.url} was expected`);
    asked.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return answer(request);
  });
  return asked;
}

/** Cloudflare's v4 envelope. */
const envelope = (status: number, result: object | null, codes: readonly number[] = []) =>
  Response.json(
    {
      success: status === 200,
      errors: codes.map((code) => ({ code, message: `error ${code}` })),
      messages: [],
      result,
    },
    { status },
  );
const reachable = () => envelope(200, { subdomain: "acme" });

const target = (credential: string) => ({ provider: "cloudflare", accountId: ACCOUNT, credential });

afterEach(() => {
  vi.restoreAllMocks();
});

// The Project DO, over RPC, passes the same contract as the in-memory deploy targets.
PORTS.DeployTargets.contract("Project DO over RPC", () => ({
  layer: DeployTargetsRpc((projectId) => drainProject(projectId)),
  establish: (projectId) => Effect.promise(() => establishProject(projectId)),
}));

describe("a namespace's credentials", () => {
  it("[cred.write-only] the secret's bytes are in no answer: not the one that stores it, not the list, not a refused deploy target's problem", async () => {
    drainNamespace(POOL_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const secret = freshToken();
    const created = await call("/namespaces/pool/credentials", {
      token: owner.token,
      method: "POST",
      body: { label: "ci", provider: "cloudflare", secret },
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.json).toSorted()).toEqual([
      "createdAt",
      "createdBy",
      "id",
      "label",
      "provider",
    ]);
    expect(created.json["createdBy"]).toBe(owner.userId);
    const listed = await call("/namespaces/pool/credentials", { token: owner.token });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain(String(created.json["id"]));
    // A token that does not reach the account: the secret went to Cloudflare in the header, and
    // the problem names what failed, never the secret.
    const asked = cloudflare(() => envelope(403, null, [10_001]));
    const projectId = await freshProject();
    const unreachable = await call(`/projects/${projectId}/deploy-targets/preview`, {
      token: owner.token,
      method: "PUT",
      body: target(String(created.json["id"])),
    });
    expect([unreachable.status, unreachable.json["code"]]).toEqual([
      422,
      "deploy_target.unreachable",
    ]);
    expect(asked.map((a) => a.authorization)).toEqual([`Bearer ${secret}`]);
    for (const answer of [created, listed, unreachable])
      expect([answer.status, answer.text.includes(secret)]).toEqual([answer.status, false]);
  });

  it("[cred.owner-only] a maintainer, a member, an outsider and an agent are refused every credential operation; the owner stores, lists and deletes", async () => {
    drainNamespace(POOL_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const id = await stored(owner.token, "pool");
    const maintainer = await seedUser(uniqueHandle("maintainer"), { role: "maintainer" });
    const member = await seedUser(uniqueHandle("member"), { role: "member" });
    const outsider = await seedUser(uniqueHandle("outsider"), { org: OTHER_ORG });
    const agent = await tokenFor(await seedAgent());
    const operations = [
      {
        method: "POST",
        path: "/namespaces/pool/credentials",
        body: { label: "x", provider: "cloudflare", secret: freshToken() },
      },
      { method: "GET", path: "/namespaces/pool/credentials" },
      { method: "DELETE", path: `/namespaces/pool/credentials/${id}` },
    ];
    const refusals = [
      { token: maintainer.token, detail: "Refused: role." },
      { token: member.token, detail: "Refused: role." },
      { token: outsider.token, detail: "Refused: role." },
      { token: agent, detail: "Refused: users-only." },
    ];
    for (const { token, detail } of refusals)
      for (const { method, path, body } of operations) {
        const answer = await call(path, { token, method, ...(body === undefined ? {} : { body }) });
        expect([method, path, answer.status, answer.json["detail"]]).toEqual([
          method,
          path,
          403,
          detail,
        ]);
      }
    const listed = await call("/namespaces/pool/credentials", { token: owner.token });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain(id);
    expect(
      (await call(`/namespaces/pool/credentials/${id}`, { token: owner.token, method: "DELETE" }))
        .status,
    ).toBe(204);
    const after = await call("/namespaces/pool/credentials", { token: owner.token });
    expect(after.text.includes(id)).toBe(false);
    expect(
      (await call(`/namespaces/pool/credentials/${id}`, { token: owner.token, method: "DELETE" }))
        .status,
    ).toBe(404);
  });
});

describe("a project's deploy targets", () => {
  it("[target.owner-only] a maintainer, a member, an outsider and an agent are refused every deploy target operation; the owner sets, lists and clears", async () => {
    drainNamespace(POOL_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const credential = await stored(owner.token, "pool");
    const seeded = await seedAgent();
    const agent = await tokenFor(seeded);
    // The agent's own project, made public so an outsider sees it and is refused by role, not hidden from.
    const projectId = seeded.agent.projectId ?? (await freshProject());
    drainProject(projectId);
    const published = await call(`/projects/${projectId}/settings`, {
      token: owner.token,
      method: "PUT",
      body: { protectedPaths: [], maxBatchSize: 1, visibility: "public" },
    });
    expect(published.status).toBe(200);
    const maintainer = await seedUser(uniqueHandle("maintainer"), { role: "maintainer" });
    const member = await seedUser(uniqueHandle("member"), { role: "member" });
    const outsider = await seedUser(uniqueHandle("outsider"), { org: OTHER_ORG });
    const asked = cloudflare(reachable);
    const operations = [
      {
        method: "PUT",
        path: `/projects/${projectId}/deploy-targets/preview`,
        body: target(credential),
      },
      { method: "GET", path: `/projects/${projectId}/deploy-targets` },
      { method: "DELETE", path: `/projects/${projectId}/deploy-targets/preview` },
    ];
    const refusals = [
      { token: maintainer.token, detail: "Refused: role." },
      { token: member.token, detail: "Refused: role." },
      { token: outsider.token, detail: "Refused: role." },
      { token: agent, detail: "Refused: users-only." },
    ];
    for (const { token, detail } of refusals)
      for (const { method, path, body } of operations) {
        const answer = await call(path, { token, method, ...(body === undefined ? {} : { body }) });
        expect([method, path, answer.status, answer.json["detail"]]).toEqual([
          method,
          path,
          403,
          detail,
        ]);
      }
    expect(asked).toEqual([]);
    const set = await call(`/projects/${projectId}/deploy-targets/preview`, {
      token: owner.token,
      method: "PUT",
      body: target(credential),
    });
    expect(set.status).toBe(200);
    expect(
      (await call(`/projects/${projectId}/deploy-targets`, { token: owner.token })).json,
    ).toEqual({
      targets: [set.json],
    });
    expect(
      (
        await call(`/projects/${projectId}/deploy-targets/preview`, {
          token: owner.token,
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });

  it("[target.credential-in-org] a credential of another org is refused 409, and Cloudflare is never asked", async () => {
    drainNamespace(POOL_ORG);
    drainNamespace(OTHER_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const theirs = await seedUser(uniqueHandle("their-owner"), { role: "owner", org: OTHER_ORG });
    const foreign = await stored(theirs.token, "elsewhere");
    const projectId = await freshProject();
    const asked = cloudflare(reachable);
    const refused = await call(`/projects/${projectId}/deploy-targets/preview`, {
      token: owner.token,
      method: "PUT",
      body: target(foreign),
    });
    expect([refused.status, refused.json["code"]]).toEqual([409, "deploy_target.refused"]);
    expect(asked).toEqual([]);
    expect(
      (await call(`/projects/${projectId}/deploy-targets`, { token: owner.token })).json,
    ).toEqual({
      targets: [],
    });
  });

  it("[target.reachable] a token Cloudflare refuses (401) is a 422 deploy_target.unreachable, and nothing is set", async () => {
    drainNamespace(POOL_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const credential = await stored(owner.token, "pool");
    const projectId = await freshProject();
    const asked = cloudflare(() => envelope(401, null, [10_000]));
    const refused = await call(`/projects/${projectId}/deploy-targets/preview`, {
      token: owner.token,
      method: "PUT",
      body: target(credential),
    });
    expect([refused.status, refused.json["code"]]).toEqual([422, "deploy_target.unreachable"]);
    expect(String(refused.json["detail"])).toContain("10000");
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      `GET ${CLOUDFLARE_API}/accounts/${ACCOUNT}/workers/subdomain`,
    ]);
    expect(
      (await call(`/projects/${projectId}/deploy-targets`, { token: owner.token })).json,
    ).toEqual({
      targets: [],
    });
  });

  it("[target.no-subdomain] an account with no workers.dev subdomain (10007) is a 422 deploy_target.no_workers_dev that names the fix, and Keel makes none", async () => {
    drainNamespace(POOL_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const credential = await stored(owner.token, "pool");
    const projectId = await freshProject();
    const asked = cloudflare(() => envelope(404, null, [10_007]));
    const refused = await call(`/projects/${projectId}/deploy-targets/preview`, {
      token: owner.token,
      method: "PUT",
      body: target(credential),
    });
    expect([refused.status, refused.json["code"]]).toEqual([422, "deploy_target.no_workers_dev"]);
    expect(String(refused.json["detail"])).toContain(
      "set a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages → your subdomain)",
    );
    expect(asked.map((a) => a.method)).toEqual(["GET"]);
    expect(asked.filter((a) => a.method === "PUT" && a.url.endsWith("/workers/subdomain"))).toEqual(
      [],
    );
    expect(
      (await call(`/projects/${projectId}/deploy-targets`, { token: owner.token })).json,
    ).toEqual({
      targets: [],
    });
  });

  it("[target.set-clear] a target set is listed with its account's workers.dev subdomain, and once cleared is gone", async () => {
    drainNamespace(POOL_ORG);
    const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
    const credential = await stored(owner.token, "pool");
    const projectId = await freshProject();
    cloudflare(reachable);
    const view = {
      name: "preview",
      provider: "cloudflare",
      accountId: ACCOUNT,
      credential,
      workersDev: "acme.workers.dev",
    };
    const set = await call(`/projects/${projectId}/deploy-targets/preview`, {
      token: owner.token,
      method: "PUT",
      body: target(credential),
    });
    expect([set.status, set.json]).toEqual([200, view]);
    const list = () => call(`/projects/${projectId}/deploy-targets`, { token: owner.token });
    expect((await list()).json).toEqual({ targets: [view] });
    const clear = () =>
      call(`/projects/${projectId}/deploy-targets/preview`, {
        token: owner.token,
        method: "DELETE",
      });
    const cleared = await clear();
    expect([cleared.status, cleared.text]).toEqual([204, ""]);
    expect((await list()).json).toEqual({ targets: [] });
    expect((await clear()).status).toBe(404);
  });
});
