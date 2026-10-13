// The clone URL as the Worker answers it: `/<namespace>/<project>.git`, git's
// smart-HTTP fetch, through the real gate, the policy's read rule and real
// Project DOs placed in org `pool`. Each project's trunk and staging are in
// an in-memory code host, served by the in-memory RepoServer.
import { env } from "cloudflare:workers";
import { projectRepos } from "@keeltown/core/application/integration";
import type { ProjectId } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef } from "@keeltown/core/ports";
import { makeCodeHostMemory, makeRepoServerMemory } from "@keeltown/testing";
import { Effect } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { CLONE_CHALLENGE, CLONE_CREDENTIAL } from "../../src/adapters/driving/http/git-clone.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { signUpByPasskey } from "./auth-users.ts";
import { tokenOf } from "./auth-ways.ts";
import { BASE, type Fetch, OTHER_ORG, POOL_ORG, seedUser, uniqueHandle } from "./helpers.ts";
import { project } from "./project-harness.ts";

const ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
const RESULT = "application/x-git-upload-pack-result";
const NOT_FOUND = "Repository not found.\n";

/** The app over in-memory code: each project's trunk and its staging hold a commit of their own. */
async function serving(...projects: ProjectId[]) {
  const code = makeCodeHostMemory();
  const server = makeRepoServerMemory(code);
  const commit = (repo: RepoRef, text: string) =>
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(repo);
      return yield* code.fixture.commit(repo, "refs/heads/main", { "README.md": text });
    });
  const heads = new Map<ProjectId, { readonly trunk: string; readonly staging: string }>();
  for (const projectId of projects) {
    const repos = projectRepos(projectId);
    heads.set(
      projectId,
      // oxlint-disable-next-line no-await-in-loop -- a handful of repos, seeded one after another
      await Effect.runPromise(
        Effect.all({
          trunk: commit(repos.trunk, "# trunk\n"),
          staging: commit(repos.staging, "# staging\n"),
        }).pipe(Effect.provide(code.layer)),
      ),
    );
  }
  const { app } = makeIsolate(
    env,
    isolateLayer(env, { codeHost: code.layer, repoServer: server.layer }),
  );
  const fetch: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  const headsOf = (projectId: ProjectId) => {
    const found = heads.get(projectId);
    if (found === undefined) throw new Error(`no heads for ${projectId}`);
    return found;
  };
  return { fetch, headsOf, served: server.served };
}

const refs = (name: string, namespace = "pool") =>
  `${BASE}/${namespace}/${name}.git/info/refs?service=git-upload-pack`;
const nameOf = (projectId: ProjectId) => projectId.toLowerCase();
const basic = (username: string, password: string) => ({
  authorization: `Basic ${btoa(`${username}:${password}`)}`,
});
/** What a refusal says: its status, the challenge it carries and its words. */
const said = async (response: Response) => ({
  status: response.status,
  challenge: response.headers.get("www-authenticate"),
  type: response.headers.get("content-type"),
  text: await response.text(),
});
const ASKED = {
  status: 401,
  challenge: CLONE_CHALLENGE,
  type: "text/plain; charset=utf-8",
  text: `${CLONE_CREDENTIAL}\n`,
};
const HIDDEN = { status: 404, challenge: null, type: "text/plain; charset=utf-8", text: NOT_FOUND };

const member = async () => seedUser(uniqueHandle("clone-member"));
/** A user of org `elsewhere` only: an outsider to org `pool`. */
const outsider = async () => seedUser(uniqueHandle("clone-outsider"), { org: OTHER_ORG });

describe("the clone URL through the Worker", () => {
  it("[clone.wired] anyone fetches a public project's trunk, and only its trunk, and a push is refused in Keel's words", async () => {
    const p = await project();
    await p.open();
    const w = await serving(p.projectId);
    const { trunk, staging } = w.headsOf(p.projectId);

    const advertised = await w.fetch(refs(nameOf(p.projectId)));
    expect([advertised.status, advertised.headers.get("content-type")]).toEqual([
      200,
      ADVERTISEMENT,
    ]);
    const listed = await advertised.text();
    expect(listed).toContain(`${trunk} refs/heads/main`);
    expect(listed).not.toContain(staging);

    const want = `want ${trunk}\n`;
    const packed = await w.fetch(`${BASE}/pool/${nameOf(p.projectId)}.git/git-upload-pack`, {
      method: "POST",
      headers: { "content-type": "application/x-git-upload-pack-request" },
      body: `${(want.length + 4).toString(16).padStart(4, "0")}${want}00000009done\n`,
    });
    expect([packed.status, packed.headers.get("content-type")]).toEqual([200, RESULT]);
    expect(new TextDecoder().decode(await packed.arrayBuffer())).toContain("PACK");
    expect(w.served.map((s) => [s.repo, s.service])).toEqual([
      [projectRepos(p.projectId).trunk, "advertise"],
      [projectRepos(p.projectId).trunk, "negotiate"],
    ]);

    const pushed = await w.fetch(
      `${BASE}/pool/${nameOf(p.projectId)}.git/info/refs?service=git-receive-pack`,
    );
    expect([pushed.status, await pushed.text()]).toEqual([
      403,
      expect.stringContaining("Keel serves git fetches only"),
    ]);
  });

  it("[clone.private] a private project asks nobody's git for a credential, opens to a member's, and reads to anyone else as a project that is not there", async () => {
    const p = await project();
    const w = await serving(p.projectId);
    const reader = await member();
    const stranger = await outsider();
    const name = nameOf(p.projectId);

    // Git sends no credential until it is asked: a private project and a missing one ask alike.
    expect(await said(await w.fetch(refs(name)))).toEqual(ASKED);
    expect(await said(await w.fetch(refs("no-such-project")))).toEqual(ASKED);
    expect(await said(await w.fetch(refs(name, "no-such-namespace")))).toEqual(ASKED);

    const inside = await w.fetch(refs(name), { headers: basic("git", reader.token) });
    expect([inside.status, inside.headers.get("content-type")]).toEqual([200, ADVERTISEMENT]);
    expect(await inside.text()).toContain(w.headsOf(p.projectId).trunk);

    // With a credential that may not read it, a private project is a missing one, byte for byte.
    const strangers = { headers: basic("git", stranger.token) };
    expect(await said(await w.fetch(refs(name), strangers))).toEqual(HIDDEN);
    expect(await said(await w.fetch(refs("no-such-project"), strangers))).toEqual(HIDDEN);
    expect(await said(await w.fetch(refs(name, "no-such-namespace"), strangers))).toEqual(HIDDEN);
    // Nothing was asked of the host but the member's fetch.
    expect(w.served).toHaveLength(1);
  });

  it("[clone.credential] the token is the Basic password under any username, a bad one is never read as nobody, and a cookie signs nobody in", async () => {
    const hidden = await project();
    const open = await project();
    await open.open();
    const w = await serving(hidden.projectId, open.projectId);
    const reader = await member();
    const priv = refs(nameOf(hidden.projectId));
    const status = async (url: string, headers: Record<string, string>) =>
      (await w.fetch(url, { headers })).status;

    expect(await status(priv, basic("anything at all", reader.token))).toBe(200);
    expect(await status(priv, basic("", reader.token))).toBe(200);
    // As the API takes it.
    expect(await status(priv, { authorization: `Bearer ${reader.token}` })).toBe(200);
    // The username is never the token.
    expect(await status(priv, basic(reader.token, ""))).toBe(401);
    expect(await status(priv, basic(reader.token, "x-oauth-basic"))).toBe(401);
    expect(await status(priv, { authorization: "Basic not base64!" })).toBe(401);

    // A credential that is presented and bad is refused where nobody at all may read.
    const pub = refs(nameOf(open.projectId));
    expect(await status(pub, {})).toBe(200);
    expect(await said(await w.fetch(pub, { headers: basic("git", "no-such-token") }))).toEqual(
      ASKED,
    );

    // A signed-in browser's request, as the console's Worker hands it on: Keel's own Origin and
    // a session cookie the API takes. Here it is nobody's, and the same session as a password opens.
    const handle = uniqueHandle("clone-browser");
    const { jar } = await signUpByPasskey(handle);
    await env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       SELECT ?1, ?2, id, 'member', ?3 FROM user WHERE username = ?4`,
    )
      .bind(ulid(), POOL_ORG, new Date().toISOString(), handle)
      .run();
    const browser = { cookie: jar.header(), origin: BASE, "cf-worker": "keel.localhost" };
    expect(
      await status(`${BASE}/v1/namespaces/pool/projects/${nameOf(hidden.projectId)}`, browser),
    ).toBe(200);
    expect(await said(await w.fetch(priv, { headers: browser }))).toEqual(ASKED);
    expect(await status(priv, { ...browser, ...basic(handle, tokenOf(jar)) })).toBe(200);
  });
});
