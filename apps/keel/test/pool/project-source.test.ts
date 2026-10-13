// What a new project's trunk may be forked from, through the real HTTP doorway,
// gate, policy and handlers, into each project's real Project DO over RPC. The
// pool cannot reach the core namespace (Artifacts has no local simulator), so
// every Project DO runs on one in-memory code host, as projects.test.ts has
// them: a fork there copies the source's refs, so a new trunk's head is read
// back and compared with its source's.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { projectIdFor } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import { makeId, type NamespaceId, type ProjectId, UserId } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef } from "@keeltown/core/ports";
import { makeCodeHostMemory, makeTrunksMemory, makeWorkspacePoolMemory } from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { signUp } from "../../../../scripts/lib/account.ts";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { ProjectsRpc, type ProjectStub } from "../../src/adapters/driven/do-rpc/projects.ts";
import { backbone } from "../../src/composition/do.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  BASE,
  drainAfter,
  type Fetch,
  OTHER_ORG,
  OTHER_SPONSOR,
  seedOrg,
  seedUser,
  uniqueHandle,
} from "./helpers.ts";

const TEMPLATE = "fixture-forge-lite";
const MAIN = "refs/heads/main";

interface Problem {
  readonly code?: string;
  readonly detail?: string;
  readonly nextActions?: readonly Record<string, unknown>[];
}
interface Made {
  readonly id: ProjectId;
  readonly namespace: { readonly handle: string; readonly kind: string };
  readonly name: string;
  readonly visibility: string;
  readonly viewer?: { readonly role: string };
}
interface Creating {
  readonly namespace: string;
  readonly name: string;
  readonly source:
    | { readonly kind: "template"; readonly name: string }
    | { readonly kind: "fork"; readonly project: string };
}

/** The template, as a request's source. */
const FROM_TEMPLATE = { kind: "template", name: "fixture-forge-lite" } as const;
/** A fork of the project, as a request's source. */
const forkOf = (project: string) => ({ kind: "fork", project }) as const;

const key = () => `prj-${crypto.randomUUID()}`;

/** A refusal's body with its request id dropped: what two refusals are compared by. */
const blank = (body: object) => {
  const { requestId: _, ...rest } = Object(body);
  return rest;
};

/** The id a create under `idempotencyKey` would have given its project, had one been made. */
const wouldBe = (userId: string, idempotencyKey: string) =>
  projectIdFor({ _tag: "User", userId: Schema.decodeUnknownSync(UserId)(userId) }, idempotencyKey);

/** Whether a project holds a place in an org: the row a create writes before anything is made. */
const placed = async (projectId: ProjectId) =>
  (await env.DB.prepare(`SELECT id FROM projects WHERE id = ?`).bind(projectId).first()) !== null;

/** Makes a user a member of another org too, as Better Auth writes a membership. */
const joins = async (userId: string, org: NamespaceId) => {
  await env.DB.prepare(
    `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)`,
  )
    .bind(ulid(), org, userId, new Date().toISOString())
    .run();
};

/**
 * The app over real Project DOs that share one in-memory code host. The host
 * holds the template unless `template` is false.
 */
function sourceApp(options: { readonly template?: boolean } = {}) {
  const code = makeCodeHostMemory();
  const onHost = <A, E>(effect: Effect.Effect<A, E, CodeHost>) =>
    Effect.runPromise(effect.pipe(Effect.provide(code.layer)));
  /** Puts a repo on the host with one commit of its own, and answers that commit. */
  const hold = (repo: RepoRef, text: string) =>
    onHost(
      Effect.gen(function* () {
        yield* (yield* CodeHost).create(repo);
        return yield* code.fixture.commit(repo, MAIN, { "README.md": text });
      }),
    );
  const templateHead =
    options.template === false
      ? Promise.resolve(undefined)
      : hold({ namespace: "keel-core", name: TEMPLATE }, "the template");

  const rewired = new Map<ProjectId, Promise<void>>();
  /** The project's DO, on the shared code host and an in-memory trunk and pool from its first call on. */
  const project = (projectId: ProjectId): ProjectStub => {
    const stub = drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));
    const onMemory = async () => {
      await templateHead;
      if (!rewired.has(projectId)) {
        rewired.set(
          projectId,
          runInDurableObject(stub, (instance: ProjectDO, state) => {
            Reflect.set(
              instance,
              "runtime",
              ManagedRuntime.make(
                Layer.mergeAll(
                  backbone(state.storage),
                  code.layer,
                  makeTrunksMemory().layer,
                  makeWorkspacePoolMemory().layer,
                  ProjectNamespacesD1(env.DB),
                ),
              ),
            );
          }),
        );
      }
      await rewired.get(projectId);
    };
    return {
      createProject: async (command) => (await onMemory(), stub.createProject(command)),
      settings: async () => (await onMemory(), stub.settings()),
      putSettings: async (command) => (await onMemory(), stub.putSettings(command)),
      liveAnchors: async () => (await onMemory(), stub.liveAnchors()),
    };
  };
  const { app } = makeIsolate(env, isolateLayer(env, { projects: ProjectsRpc(project) }));
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);

  const call = async <B>(token: string, method: string, path: string, body: object, k?: string) => {
    const response = await via(`${BASE}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(k === undefined ? {} : { "idempotency-key": k }),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json<B>() };
  };
  /** `POST /v1/projects`, under a fresh Idempotency-Key unless one is given. */
  const create = (token: string, creating: Creating, idempotencyKey = key()) =>
    call<Made & Problem>(token, "POST", "/projects", creating, idempotencyKey);
  /** Whether the host holds the repo. */
  const holds = (repo: RepoRef) =>
    onHost(
      CodeHost.use((host) => host.info(repo)).pipe(
        Effect.as(true),
        Effect.catchTag("RepoNotFound", () => Effect.succeed(false)),
      ),
    );
  /** The head of a project's trunk on the host. */
  const head = (projectId: ProjectId) =>
    onHost(CodeHost.use((host) => host.head(projectRepos(projectId).trunk, MAIN)));

  return {
    templateHead,
    create,
    hold,
    holds,
    head,
    /** A person signed up by passkey, as any visitor is: the owner of the org their handle names. */
    signUp: async (prefix: string) => {
      const { session } = await signUp(BASE, uniqueHandle(prefix), {
        fetcher: (request) => via(request.url, request),
      });
      return session;
    },
    /**
     * A project of org `pool`, made from the template by `token` and private
     * as made, whose trunk has since moved on: its head is its own, not the
     * template's.
     */
    source: async (token: string) => {
      const made = await create(token, {
        namespace: "pool",
        name: uniqueHandle("src"),
        source: FROM_TEMPLATE,
      });
      expect(made.status).toBe(201);
      const { trunk } = projectRepos(made.body.id);
      const moved = await onHost(code.fixture.commit(trunk, MAIN, { "PLAN.md": "ours alone" }));
      return { id: made.body.id, trunk: trunk.name, head: moved };
    },
    /** A maintainer makes the project public through the settings route. */
    open: async (token: string, projectId: ProjectId) => {
      const put = await call(token, "PUT", `/projects/${projectId}/settings`, {
        protectedPaths: [],
        maxBatchSize: 1,
        visibility: "public",
      });
      expect(put.status).toBe(200);
    },
  };
}

const maintainer = () => seedUser(uniqueHandle("maintainer"), { role: "maintainer" });

const NOT_FOUND = {
  type: "urn:keel:problem:resource.not_found",
  title: "No such resource",
  status: 404,
  code: "resource.not_found",
};

describe("a new project's source", () => {
  it("[project.source-private] a private project's trunk is no source to someone who cannot read it, nor across orgs to someone who can: nothing is made and no name is taken", async () => {
    const world = sourceApp();
    const secret = await world.source((await maintainer()).token);

    // Anyone who signs up, creating in the org that is theirs, naming the trunk by the project's id.
    const stranger = await world.signUp("stranger");
    const wanted = { namespace: stranger.handle, name: "copied", source: forkOf(secret.id) };
    const asked = key();
    const refused = await world.create(stranger.token, wanted, asked);
    expect([refused.status, blank(refused.body)]).toEqual([404, { ...NOT_FOUND, nextActions: [] }]);
    // A project that was never made reads the same.
    const never: ProjectId = makeId("prj", ulid());
    const missing = await world.create(stranger.token, { ...wanted, source: forkOf(never) });
    expect([missing.status, blank(missing.body)]).toEqual([refused.status, blank(refused.body)]);
    // The refused call made no project: it holds no place and has no trunk.
    const unmade = wouldBe(stranger.userId, asked);
    expect([await placed(unmade), await world.holds(projectRepos(unmade).trunk)]).toEqual([
      false,
      false,
    ]);
    // So the name it asked for is still free in the org.
    const free = await world.create(stranger.token, { ...wanted, source: FROM_TEMPLATE });
    expect([free.status, free.body.name]).toEqual([201, "copied"]);
    expect(await world.head(free.body.id)).toBe(await world.templateHead);

    // A member of the project's org reads it, and still may not carry it into another org.
    await seedOrg(OTHER_ORG, "elsewhere", OTHER_SPONSOR, "elsewhere-owner");
    const member = await seedUser(uniqueHandle("member"));
    await joins(member.userId, OTHER_ORG);
    const carried = key();
    const across = await world.create(
      member.token,
      { namespace: "elsewhere", name: "carried", source: forkOf(secret.id) },
      carried,
    );
    expect([across.status, blank(across.body)]).toEqual([
      403,
      {
        type: "urn:keel:problem:auth.forbidden",
        title: "The policy refuses this caller this action",
        status: 403,
        code: "auth.forbidden",
        detail: "Refused: private-source.",
        nextActions: [
          {
            kind: "escalate",
            title:
              "A private project forks only into its own org; ask a maintainer to make it public",
          },
        ],
      },
    ]);
    const uncarried = wouldBe(member.userId, carried);
    expect([await placed(uncarried), await world.holds(projectRepos(uncarried).trunk)]).toEqual([
      false,
      false,
    ]);
  });

  it("[project.source-readable] a project's trunk is a source to whoever reads the project: a member within its org, and anyone once it is public", async () => {
    const world = sourceApp();
    const owner = await maintainer();
    const source = await world.source(owner.token);
    expect(source.head).not.toBe(await world.templateHead);

    const member = await seedUser(uniqueHandle("member"));
    const within = await world.create(member.token, {
      namespace: "pool",
      name: uniqueHandle("fork"),
      source: forkOf(source.id),
    });
    expect([within.status, within.body.namespace.handle, within.body.viewer]).toEqual([
      201,
      "pool",
      { role: "member" },
    ]);
    expect(await world.head(within.body.id)).toBe(source.head);

    // Someone outside the org: refused while the project is private, and forks it once it is public.
    const anyone = await world.signUp("anyone");
    const theirs = { namespace: anyone.handle, name: "theirs", source: forkOf(source.id) };
    expect((await world.create(anyone.token, theirs)).status).toBe(404);
    await world.open(owner.token, source.id);
    const forked = await world.create(anyone.token, theirs);
    expect([
      forked.status,
      forked.body.namespace.handle,
      forked.body.name,
      forked.body.visibility,
    ]).toEqual([201, anyone.handle, "theirs", "private"]);
    expect(await world.head(forked.body.id)).toBe(source.head);
  });

  it("[project.source-unknown] a name that is no template is no source, whatever the core namespace holds by it", async () => {
    const world = sourceApp();
    const owner = await maintainer();
    const source = await world.source(owner.token);
    // Every repo named here that could be on the host is: only how the name reads refuses it.
    const repos = projectRepos(source.id);
    await world.hold(repos.guards, "guards");
    await world.hold({ namespace: "keel-core", name: "no-such" }, "not a template");
    expect([await world.holds(repos.staging), await world.holds(repos.guards)]).toEqual([
      true,
      true,
    ]);

    const name = uniqueHandle("wanted");
    for (const unknown of [
      "no-such",
      repos.staging.name,
      repos.guards.name,
      "keel-core/x",
      source.trunk,
      `keel-core/${source.trunk}`,
    ]) {
      const asked = key();
      const answer = await world.create(
        owner.token,
        { namespace: "pool", name, source: { kind: "template", name: unknown } },
        asked,
      );
      expect([unknown, answer.status, blank(answer.body)]).toEqual([
        unknown,
        404,
        {
          ...NOT_FOUND,
          detail: `No template has the name "${unknown}".`,
          nextActions: [
            {
              kind: "call",
              title: `Create the project from the template ${TEMPLATE}`,
              operationId: "Operator_createProject",
              args: { namespace: "pool", name, source: FROM_TEMPLATE },
            },
          ],
        },
      ]);
      expect([unknown, await placed(wouldBe(owner.userId, asked))]).toEqual([unknown, false]);
    }
    // No refusal took the name: the next action's own arguments make the project.
    const made = await world.create(owner.token, {
      namespace: "pool",
      name,
      source: FROM_TEMPLATE,
    });
    expect([made.status, made.body.name]).toEqual([201, name]);
  });

  it("[project.source-absent] a template the core namespace does not hold answers 404, naming its repo, and the project that was not made holds no place: its name is free for the next try", async () => {
    const world = sourceApp({ template: false });
    const owner = await maintainer();
    const asked = key();
    const early = { namespace: "pool", name: uniqueHandle("early"), source: FROM_TEMPLATE };
    const missing = await world.create(owner.token, early, asked);
    expect([missing.status, missing.body.code, missing.body.detail]).toEqual([
      404,
      "resource.not_found",
      `No source repo ${TEMPLATE} in namespace keel-core.`,
    ]);
    expect(missing.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "Operator_createProject" }),
    ]);
    // The refused start gave its place back: no row, and the same name is taken by the next try under another key.
    expect(await placed(wouldBe(owner.userId, asked))).toBe(false);
    await world.hold({ namespace: "keel-core", name: TEMPLATE }, "the template");
    const next = await world.create(owner.token, early);
    expect([next.status, next.body.name]).toEqual([201, early.name]);
  });
});
