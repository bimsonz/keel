// Proposals from a fork on the real objects. A fork's landing is proposed over
// the doorway to the project it was forked from: the project's ledger
// reserves it, its Change DO copies the commit in and parks it for approval
// with no batch formed; a maintainer's approval over MCP puts it on the real
// Lane, which composes it as its proposer's, and the real Trunk lands it. A
// new commit takes the approval away and the lane lets it go; each refusal is
// told by its own code with nothing reserved; and a fork synced over the
// doorway proposes only what it adds since.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_OPEN_PROPOSALS } from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import type { Change } from "@keeltown/core/domain/coordination";
import { agentIdOf } from "@keeltown/core/domain/identity";
import {
  agentActor,
  type ChangeId,
  type CommitSha,
  contentHashOf,
  makeId,
  NamespaceId,
  type ProjectId,
  type UserId,
} from "@keeltown/core/kernel";
import {
  CodeHost,
  EntityStore,
  NamespaceUsage,
  ProposalLedger,
  Trunks,
  WorkspacePool,
  WorkspaceRebaser,
} from "@keeltown/core/ports";
import {
  heldLease,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeNamespaceUsageMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  makeWorkspaceRebaserMemory,
  makeWorkspaceWriterMemory,
} from "@keeltown/testing";
import { PushRejected } from "@keeltown/core/domain/integration";
import { decodeCommit } from "@keeltown/gitcore";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import { HumanGateRpc } from "../../src/adapters/driven/do-rpc/human-gate.ts";
import { ProposalLedgerRpc } from "../../src/adapters/driven/do-rpc/proposal-ledger.ts";
import { TrunksRpc } from "../../src/adapters/driven/do-rpc/trunks.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { decisionsLayer, liveChangesLayer } from "../../src/composition/do.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { ChangeCodecs, decodeExit, LaneCodecs } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeStub, changeUnderTest, ok, rewire } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  drainOutbox,
  establishProject,
  type Fetch,
  mcp,
  mcpResult,
  placeProject,
  POOL_ORG,
  seedAgent,
  type SeededAgent,
  seedOrg,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { placedIn } from "./pool-harness.ts";
import { PLAN_HASH, realLane, realTrunk } from "./real-lane.ts";

const WAIT = { timeout: 20_000, interval: 50 };
/** A case that lands through two lanes takes longer than one change does. */
const LONG = 120_000;
const README = { "README.md": "keel\n" };

const projectStub = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A call through the doorway, with a fresh Idempotency-Key unless one is given. */
async function call(
  via: Fetch,
  bearer: string,
  method: string,
  path: string,
  body?: object,
  key = `key-${ulid()}`,
): Promise<Answer> {
  const response = await via(`${BASE}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(method === "GET" ? {} : { "idempotency-key": key }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}

/** A tool call's answer over MCP: whether it failed, and its structured content or the failure's problem. */
async function tool(via: Fetch, token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(
    await mcp(token, "tools/call", { name, arguments: args }, name, via),
  );
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return {
    isError: result["isError"] === true,
    body: Object(
      result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined),
    ),
  };
}

/** A refusal's status and code. */
const refusal = (answer: Answer) => [answer.status, answer.body["code"]];

/** The proposals the project's ledger holds a place for: each reserved or open. */
const reservations = (projectId: ProjectId) =>
  runInDurableObject(projectStub(projectId), (instance: ProjectDO) =>
    instance["runtime"].runPromise(
      EntityStore.use((store) => Effect.sync(() => store.list("proposal-open").length)),
    ),
  );

/** The change id the project's ledger reserves for a proposer's key and body, as the doorway's propose asks for it. */
const reserve = (
  projectId: ProjectId,
  proposer: SeededAgent,
  key: string,
  fingerprint: string,
): Promise<ChangeId> =>
  Effect.runPromise(
    Effect.flatMap(ProposalLedger, (ledger) =>
      ledger.reserve(projectId, {
        proposer: agentActor(proposer.agent.id),
        idempotencyKey: key,
        fingerprint,
      }),
    ).pipe(Effect.provide(ProposalLedgerRpc(projectStub)), Effect.orDie),
  );

/** Trunk's head, as its Trunk DO records it. */
const headOf = (projectId: ProjectId) =>
  Effect.runPromise(
    Effect.flatMap(Trunks, (trunks) => trunks.head(projectId)).pipe(
      Effect.provide(TrunksRpc(env.TRUNK)),
    ),
  );

/** Queues an agent's change: declared, submitted, Precheck started and its plan compiled, all by hand. */
async function queue(c: ChangeUnderTest) {
  const lease = heldLease(ok(await c.declare()).change).id;
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({
        agentId: c.agentId,
        projectId: c.projectId,
        leaseId: lease,
        commitSha: await c.push(),
        idempotencyKey: "submit-1",
      }),
    ),
  );
  await prechecked(c.stub, "p-1");
}

type ChangeStub = ReturnType<typeof changeStub>;

/** Precheck's pass over the change's submitted commit, started and its plan compiled by hand. */
async function prechecked(stub: ChangeStub, instanceId: string) {
  const { intent, commitSha } = await read(stub);
  if (commitSha === undefined) throw new Error("a proposal carries its commit from the start");
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await stub.precheckStarted({ revision: intent.revision, instanceId, commitSha }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.planCompiled,
      await stub.planCompiled({
        revision: intent.revision,
        instanceId,
        planHash: PLAN_HASH,
        steps: 1,
        costEstimate: 1,
      }),
    ),
  );
}

/** The change as its object holds it. */
const read = async (stub: ChangeStub): Promise<Change> =>
  ok(decodeExit(ChangeCodecs.get, await stub.get())).change;

/** The lane's queue and the members of its batch in flight. */
const standing = async (lane: Awaited<ReturnType<typeof realLane>>) =>
  ok(decodeExit(LaneCodecs.status, await lane.stub.status()));

const REGISTER = `${BASE}/v1/oauth/register`;

/**
 * An agent that signed itself up through the Worker with a key and nothing
 * else: nobody sponsors it, and it governs its own namespace alone.
 */
async function keyAgent() {
  const account = await newKey();
  const registered = await worker(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": freshAddress(),
      dpop: await proofBy(account, "POST", REGISTER),
    },
    body: JSON.stringify({
      jwks: { keys: [account.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    }),
  });
  expect(registered.status).toBe(201);
  const agentId = agentIdOf(account.key.jkt);
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));
  /** Its own namespace, where a project it makes is placed. */
  const namespace = Schema.decodeSync(NamespaceId)(agentId);
  const token = async (project: ProjectId) =>
    (await granted(await requestToken(agentId, account, { project }))).access_token;
  return { agentId, namespace, token };
}

/** A project placed in `namespace`, held by its Project DO. */
async function aProjectIn(namespace: NamespaceId): Promise<ProjectId> {
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId, namespace);
  await establishProject(projectId);
  return projectId;
}

/**
 * Two projects on one memory code host, as two projects share Artifacts: the
 * upstream in an org of its own with a maintainer (or, `agentOwned`, in the
 * own namespace of an agent that signed itself up, which keeps it), public
 * and open to proposals unless told otherwise; the fork, in org `pool`, where
 * a sponsored agent works. The doorway is the Worker's own over that host.
 */
async function projects(
  options: {
    readonly visibility?: "public" | "private";
    readonly proposals?: "open" | "closed";
    readonly agentOwned?: boolean;
  } = {},
) {
  const code = makeCodeHostMemory();
  const { app } = makeIsolate(env, isolateLayer(env, { codeHost: code.layer }));
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  const org: NamespaceId = makeId("org", ulid());
  const owner: UserId = makeId("usr", ulid());
  await seedOrg(org, uniqueHandle("ups"), owner, uniqueHandle("owner"));
  const maintainer = await seedUser(uniqueHandle("mia"), { org, role: "maintainer" });
  const keeper = options.agentOwned === true ? await keyAgent() : undefined;
  const namespace = keeper?.namespace ?? org;
  const upstream = await aProjectIn(namespace);
  const keeps = keeper === undefined ? maintainer.token : await keeper.token(upstream);
  const settings = await call(via, keeps, "PUT", `/projects/${upstream}/settings`, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: options.visibility ?? "public",
    proposals: options.proposals ?? "open",
  });
  expect(settings.status).toBe(200);
  const fork: ProjectId = makeId("prj", ulid());
  const proposer = await seedAgent({ projectId: fork });
  return { code, via, org, namespace, maintainer, keeper, upstream, fork, proposer };
}

type Projects = Awaited<ReturnType<typeof projects>>;

/**
 * The two projects' real Lanes and Trunks: the fork's trunk started from the
 * upstream's head, as a fork's does. The upstream's composer is held by
 * `held` when given, so its batch in flight waits there.
 */
async function realObjects(w: Projects, held?: Promise<void>) {
  const composer = makeCandidateComposerMemory(held === undefined ? {} : { held });
  const up = await realLane(w.upstream, {
    code: w.code,
    places: placedIn(w.upstream, w.namespace).layer,
    composer,
  });
  await realTrunk(w.upstream, up);
  const fork = await realLane(w.fork, { code: w.code, places: placedIn(w.fork).layer });
  expect(fork.base).toBe(up.base);
  await realTrunk(w.fork, fork, { kind: "forked", project: w.upstream, commit: up.base });
  return { up, fork };
}

/**
 * An agent's change landed through `lane`, its candidate the whole tree
 * `files`: the commit trunk is at after.
 */
async function landed(
  lane: Awaited<ReturnType<typeof realLane>>,
  projectId: ProjectId,
  files: Readonly<Record<string, string>>,
): Promise<CommitSha> {
  const c = await changeUnderTest(projectId, "project");
  await queue(c);
  return verified(lane, c.stub, files);
}

/** The change's batch formed, its candidate the tree `files`, KeelVerify's land, and the change landed: the commit trunk is at. */
async function verified(
  lane: Awaited<ReturnType<typeof realLane>>,
  stub: ChangeStub,
  files: Readonly<Record<string, string>>,
): Promise<CommitSha> {
  await vi.waitFor(async () => expect((await read(stub)).state).toBe("integrating"), WAIT);
  const { batchId } = await read(stub);
  const [, started] = await lane.job(batchId);
  const commit = await lane.candidate(started.candidateId, files);
  await lane.verdict(batchId, "land", ["keel.test: pass"]);
  await vi.waitFor(async () => expect((await read(stub)).state).toBe("landed"), WAIT);
  return commit;
}

/**
 * A proposal's Change DO, run on memory adapters over the projects' code
 * host before the doorway reaches it, as every pool change runs: its id is
 * the one the project's ledger reserves for the proposer's key and body, so
 * the doorway's propose reaches it as that reservation's retry. Its
 * workspace is a repo of its own on upstream's head; `admitted` names the
 * namespace each copy into it was counted against.
 */
async function proposalObject(
  w: Projects,
  body: { readonly fork: ProjectId; readonly commit: CommitSha; readonly goal: string },
  key: string,
  /** How the object's rebaser pushes, around the memory one's: the memory one unless given. */
  rebasing: (inner: WorkspaceRebaser["Service"]) => WorkspaceRebaser["Service"] = (inner) => inner,
) {
  const changeId = await reserve(w.upstream, w.proposer, key, contentHashOf(body));
  const stub = changeStub(changeId);
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${w.proposer.agent.id}`)));
  drainAfter(env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${w.upstream}`)));
  drainAfter(env.LANE.get(env.LANE.idFromName(`lane:${w.upstream}:main`)));
  projectStub(w.upstream);
  const repo = { namespace: "memory", name: `ws-${changeId.toLowerCase()}` };
  await Effect.runPromise(
    Effect.flatMap(CodeHost, (host) => host.create(repo)).pipe(
      Effect.provide(w.code.layer),
      Effect.orDie,
    ),
  );
  const pool = makeWorkspacePoolMemory({ baseSha: await headOf(w.upstream) });
  const ownRepo = Layer.effect(
    WorkspacePool,
    Effect.map(WorkspacePool, (inner) =>
      WorkspacePool.of({
        ...inner,
        grant: (projectId, holder) =>
          Effect.map(inner.grant(projectId, holder), (grant) => ({ ...grant, repo })),
      }),
    ),
  ).pipe(Layer.provide(pool.layer));
  const admitted: NamespaceId[] = [];
  /** Each repo-bytes amount the object counted, admitted or given back, by namespace. */
  const counted: {
    readonly namespace: NamespaceId;
    readonly amount: number;
    readonly key: string;
  }[] = [];
  const usage = Layer.effect(
    NamespaceUsage,
    Effect.map(NamespaceUsage, (inner) =>
      NamespaceUsage.of({
        ...inner,
        admit: (namespace, kind, amount, countedAs) =>
          Effect.andThen(
            Effect.sync(() => {
              admitted.push(namespace);
              counted.push({ namespace, amount, key: countedAs });
            }),
            inner.admit(namespace, kind, amount, countedAs),
          ),
        record: (namespace, kind, amount, countedAs) =>
          Effect.andThen(
            Effect.sync(() => void counted.push({ namespace, amount, key: countedAs })),
            inner.record(namespace, kind, amount, countedAs),
          ),
      }),
    ),
  ).pipe(Layer.provide(makeNamespaceUsageMemory().layer));
  await rewire(stub, (objectEnv) =>
    Layer.mergeAll(
      ownRepo,
      w.code.layer,
      makeTrunksMemory().layer,
      Layer.effect(WorkspaceRebaser, Effect.map(WorkspaceRebaser, rebasing)).pipe(
        Layer.provide(makeWorkspaceRebaserMemory(w.code).layer),
      ),
      makeWorkspaceWriterMemory(w.code).layer,
      usage,
      liveChangesLayer(objectEnv),
      decisionsLayer(objectEnv),
      HumanGateRpc((address) => objectEnv.NAMESPACE.get(objectEnv.NAMESPACE.idFromName(address))),
      ProjectNamespacesD1(objectEnv.DB),
    ),
  );
  return { changeId, stub, admitted, counted, pool };
}

/** Proposes the fork's `commit` over the doorway as the projects' agent, its object made first. */
async function proposed(w: Projects, commit: CommitSha, goal: string) {
  const key = `propose-${ulid()}`;
  const body = { fork: w.fork, commit, goal };
  const object = await proposalObject(w, body, key);
  const answer = await call(
    w.via,
    await tokenFor(w.proposer),
    "POST",
    `/projects/${w.upstream}/proposals`,
    body,
    key,
  );
  expect([answer.status, answer.body["id"]]).toEqual([201, object.changeId]);
  return object;
}

/** The proposal parked for approval once Precheck's plan compiled, the lane told. */
async function awaitingApproval(stub: ChangeStub, instanceId: string) {
  await prechecked(stub, instanceId);
  await vi.waitFor(async () => {
    await drainOutbox(stub);
    expect(await read(stub)).toMatchObject({ state: "parked", parkReason: "awaiting-approval" });
  }, WAIT);
}

describe("proposals from a fork, on the real objects", () => {
  // Each Precheck a submission starts answers Stale while the case drives its passes by hand.
  let prechecks: Awaited<ReturnType<typeof inertPrecheck>> | undefined;
  beforeEach(async () => {
    prechecks = await inertPrecheck();
  });
  afterEach(async () => {
    await prechecks?.dispose();
  });

  it(
    "[proposal.real] a sponsored agent proposes its fork's landing over the doorway: it parks for approval with no batch formed; a maintainer's approval over MCP queues it on the real Lane, which composes it as its proposer's, and it lands through the real Trunk; [proposal.giveback-on-land] landed, it gives its fork's namespace back what it copied in",
    async () => {
      const w = await projects();
      const lanes = await realObjects(w);
      const work = await landed(lanes.fork, w.fork, { ...README, "src/fork-one.ts": "one\n" });
      expect(await headOf(w.fork)).toBe(work);

      const { changeId, stub, admitted, counted } = await proposed(
        w,
        work,
        "Add the first fork file",
      );
      // What it copied in is the fork's to count, never the project's it is proposed to.
      expect(admitted).toEqual([POOL_ORG]);
      expect(await read(stub)).toMatchObject({
        origin: "proposal",
        commitSha: work,
        baseSha: lanes.up.base,
        proposal: { fork: w.fork, proposer: `agent:${w.proposer.agent.id}` },
        intent: { footprint: [{ path: "src/fork-one.ts", op: "create" }] },
      });
      expect((await read(stub)).agentId).toBeUndefined();
      await awaitingApproval(stub, "p-1");
      await drainOutbox(lanes.up.stub);
      expect(await standing(lanes.up)).toEqual({ queued: 0, inFlight: 0 });
      expect(lanes.up.composer.requests).toEqual([]);

      const approved = await tool(w.via, w.maintainer.token, "approveProposal", {
        changeId,
        "idempotency-key": "approve-1",
        commit: work,
      });
      expect(approved).toMatchObject({ isError: false, body: { proposal: { approved: work } } });
      const landedAt = await verified(lanes.up, stub, { ...README, "src/fork-one.ts": "one\n" });
      expect(await headOf(w.upstream)).toBe(landedAt);
      const [member] = lanes.up.composer.requests.flatMap((request) => request.members);
      expect(member).toMatchObject({
        changeId,
        head: work,
        proposer: {
          actor: `agent:${w.proposer.agent.id}`,
          from: { project: w.fork, commit: work },
        },
      });
      expect(member?.agent).toBeUndefined();
      // [proposal.giveback-on-land] Landed, it gives back to the fork's namespace what it copied in.
      await runDurableObjectAlarm(stub);
      const copied = counted.reduce((sum, c) => sum + (c.amount > 0 ? c.amount : 0), 0);
      expect(copied).toBeGreaterThan(0);
      expect(counted.filter((c) => c.amount < 0)).toEqual([
        { namespace: POOL_ORG, amount: -copied, key: `proposal-giveback:${changeId}` },
      ]);
    },
    LONG,
  );

  it(
    "[proposal.new-commit] a new commit after the approval takes the approval away: the lane lets it go, and it waits for approval again; [proposal.moved-footprint] its footprint is the new commit's",
    async () => {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const w = await projects();
      const lanes = await realObjects(w, held);
      const first = await landed(lanes.fork, w.fork, { ...README, "src/fork-one.ts": "one\n" });

      // A change of upstream's own is in flight, its compose held: what is approved waits in the queue.
      const ahead = await changeUnderTest(w.upstream, "project");
      await queue(ahead);
      await vi.waitFor(() => expect(lanes.up.composer.requests).toHaveLength(1), WAIT);

      const { changeId, stub } = await proposed(w, first, "Add the fork's files");
      await awaitingApproval(stub, "p-1");
      const yes = await call(
        w.via,
        w.maintainer.token,
        "POST",
        `/changes/${changeId}/proposal/approval`,
        { commit: first },
      );
      expect(yes.status).toBe(200);
      await vi.waitFor(async () => {
        await drainOutbox(stub);
        expect(await standing(lanes.up)).toEqual({ queued: 1, inFlight: 1 });
      }, WAIT);

      const second = await landed(lanes.fork, w.fork, {
        ...README,
        "src/fork-one.ts": "one\n",
        "src/fork-two.ts": "two\n",
      });
      const moved = await call(
        w.via,
        await tokenFor(w.proposer),
        "POST",
        `/changes/${changeId}/proposal/commits`,
        { commit: second, note: "and a second file" },
      );
      expect(moved.status).toBe(200);
      await vi.waitFor(async () => {
        await drainOutbox(stub);
        expect(await standing(lanes.up)).toEqual({ queued: 0, inFlight: 1 });
      }, WAIT);
      await awaitingApproval(stub, "p-2");
      const now = await read(stub);
      expect(now.commitSha).toBe(second);
      expect(now.proposal?.approved).toBeUndefined();
      expect(now.intent.footprint.map((entry) => entry.path).toSorted()).toEqual([
        "src/fork-one.ts",
        "src/fork-two.ts",
      ]);
      expect(lanes.up.composer.requests.flatMap((r) => r.members.map((m) => m.changeId))).toEqual([
        ahead.changeId,
      ]);

      release?.();
      await verified(lanes.up, ahead.stub, { ...README, "src/ahead.ts": "ahead\n" });
    },
    LONG,
  );

  it(
    "[proposal.propose-serial] a retry of a propose under its key that races the first waits for it and answers the change it made, never pushing: the workspace the first commits with is never given back",
    async () => {
      const w = await projects();
      const lanes = await realObjects(w);
      const work = await landed(lanes.fork, w.fork, { ...README, "src/fork-one.ts": "one\n" });
      const key = `propose-${ulid()}`;
      const body = { fork: w.fork, commit: work, goal: "Add the fork's file" };
      let release: (() => void) | undefined;
      const latch = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pushes = 0;
      const object = await proposalObject(w, body, key, (inner) => ({
        ...inner,
        // The first push waits on the latch; one that races it is refused, as Artifacts refuses a stale push.
        pushProposal: (...args) =>
          ++pushes === 1
            ? Effect.andThen(
                Effect.promise(() => latch),
                inner.pushProposal(...args),
              )
            : Effect.fail(new PushRejected({ reason: "stale" })),
      }));
      const token = await tokenFor(w.proposer);
      const path = `/projects/${w.upstream}/proposals`;
      const first = call(w.via, token, "POST", path, body, key);
      await vi.waitFor(() => expect(pushes).toBe(1), WAIT);
      const second = call(w.via, token, "POST", path, body, key);
      // Long enough for a racing retry to reach its push.
      await new Promise((resolve) => setTimeout(resolve, 500));
      release?.();
      const answers = await Promise.all([first, second]);

      expect(answers.map((a) => [a.status, a.body["id"]])).toEqual([
        [201, object.changeId],
        [201, object.changeId],
      ]);
      expect(pushes).toBe(1);
      expect([...object.pool.released.keys()]).toEqual([]);
      expect(await read(object.stub)).toMatchObject({ state: "submitted", commitSha: work });
    },
    LONG,
  );

  it(
    "[proposal.commit-moved] an approval of the commit the maintainer read, once its proposer moved it, is proposal.commit_moved and approves nothing",
    async () => {
      const w = await projects();
      const lanes = await realObjects(w);
      const first = await landed(lanes.fork, w.fork, { ...README, "src/fork-one.ts": "one\n" });
      const { changeId, stub } = await proposed(w, first, "Add the fork's files");
      await awaitingApproval(stub, "p-1");
      const second = await landed(lanes.fork, w.fork, {
        ...README,
        "src/fork-one.ts": "one\n",
        "src/fork-two.ts": "two\n",
      });
      expect(
        (
          await call(
            w.via,
            await tokenFor(w.proposer),
            "POST",
            `/changes/${changeId}/proposal/commits`,
            {
              commit: second,
            },
          )
        ).status,
      ).toBe(200);
      await awaitingApproval(stub, "p-2");

      const stale = await call(
        w.via,
        w.maintainer.token,
        "POST",
        `/changes/${changeId}/proposal/approval`,
        { commit: first },
      );
      expect(refusal(stale)).toEqual([409, "proposal.commit_moved"]);
      expect(await read(stub)).toMatchObject({ state: "parked", parkReason: "awaiting-approval" });
      expect((await read(stub)).proposal?.approved).toBeUndefined();
      expect(lanes.up.composer.requests).toEqual([]);
    },
    LONG,
  );

  it("[proposal.unsponsored] an agent nobody sponsors proposes nothing from a fork of its own: 403 naming askSponsor, and nothing reserved", async () => {
    const w = await projects();
    const loose = await keyAgent();
    const own = await aProjectIn(loose.namespace);
    const refused = await call(
      w.via,
      await loose.token(own),
      "POST",
      `/projects/${w.upstream}/proposals`,
      { fork: own, commit: "a".repeat(40), goal: "Spam" },
    );
    expect(refusal(refused)).toEqual([403, "auth.forbidden"]);
    expect(refused.body["nextActions"]).toMatchObject([{ operationId: "askSponsor" }]);
    expect(await reservations(w.upstream)).toBe(0);
  });

  it(
    "[proposal.not-maintainer] nobody but who maintains the project approves, and an agent only while a person sponsors it: not the proposer, not a stranger, and not the agent that keeps the project while nobody sponsors it",
    async () => {
      const w = await projects({ agentOwned: true });
      const lanes = await realObjects(w);
      const work = await landed(lanes.fork, w.fork, { ...README, "src/fork-one.ts": "one\n" });
      const { changeId, stub } = await proposed(w, work, "Add the first fork file");
      await awaitingApproval(stub, "p-1");
      const approve = (token: string) =>
        call(w.via, token, "POST", `/changes/${changeId}/proposal/approval`, { commit: work });

      expect(refusal(await approve(await tokenFor(w.proposer)))).toEqual([403, "auth.forbidden"]);
      const stranger = await seedUser(uniqueHandle("sam"), { role: null });
      expect(refusal(await approve(stranger.token))).toEqual([403, "auth.forbidden"]);
      if (w.keeper === undefined) throw new Error("an agent keeps this upstream");
      const unsponsored = await approve(await w.keeper.token(w.upstream));
      expect(refusal(unsponsored)).toEqual([403, "auth.forbidden"]);
      expect(unsponsored.body["nextActions"]).toMatchObject([{ operationId: "askSponsor" }]);
      expect(await read(stub)).toMatchObject({ state: "parked", parkReason: "awaiting-approval" });
      expect((await read(stub)).proposal?.approved).toBeUndefined();
    },
    LONG,
  );

  it("[proposal.private] a private project takes no proposals: hidden from an agent outside it, and closed to a member of its org proposing from a project there, its settings' open notwithstanding", async () => {
    const w = await projects({ visibility: "private", proposals: "open" });
    const outside = await call(
      w.via,
      await tokenFor(w.proposer),
      "POST",
      `/projects/${w.upstream}/proposals`,
      { fork: w.fork, commit: "a".repeat(40), goal: "From outside" },
    );
    expect(outside.status).toBe(404);
    const inside = await aProjectIn(w.org);
    const closed = await call(
      w.via,
      w.maintainer.token,
      "POST",
      `/projects/${w.upstream}/proposals`,
      { fork: inside, commit: "a".repeat(40), goal: "From inside" },
    );
    expect(refusal(closed)).toEqual([403, "auth.forbidden"]);
    expect(String(Object(closed.body["nextActions"])[0]?.title)).toContain("takes no proposals");
    expect(await reservations(w.upstream)).toBe(0);
  });

  it("[proposal.closed] a public project closed to proposals refuses one, naming why, and reserves nothing", async () => {
    const w = await projects({ proposals: "closed" });
    const refused = await call(
      w.via,
      await tokenFor(w.proposer),
      "POST",
      `/projects/${w.upstream}/proposals`,
      { fork: w.fork, commit: "a".repeat(40), goal: "Anyway" },
    );
    expect(refusal(refused)).toEqual([403, "auth.forbidden"]);
    expect(String(Object(refused.body["nextActions"])[0]?.title)).toContain("takes no proposals");
    expect(await reservations(w.upstream)).toBe(0);
  });

  it(
    "[proposal.limit] a proposer with five proposals open on a project is refused a sixth, pointed at the list, and holds no sixth place",
    async () => {
      const w = await projects();
      const lanes = await realObjects(w);
      const work = await landed(lanes.fork, w.fork, { ...README, "src/fork-one.ts": "one\n" });
      await Promise.all(
        Array.from({ length: MAX_OPEN_PROPOSALS }, (_, n) =>
          reserve(w.upstream, w.proposer, `open-${n}`, `body-${n}`),
        ),
      );
      const sixth = await call(
        w.via,
        await tokenFor(w.proposer),
        "POST",
        `/projects/${w.upstream}/proposals`,
        { fork: w.fork, commit: work, goal: "One too many" },
      );
      expect(refusal(sixth)).toEqual([409, "proposal.limit"]);
      expect(sixth.body["nextActions"]).toMatchObject([{ operationId: "proposals" }]);
      expect(await reservations(w.upstream)).toBe(MAX_OPEN_PROPOSALS);
    },
    LONG,
  );

  it(
    "[proposal.after-sync] upstream lands a proposal and moves on; the fork's owner syncs over the doorway, a merge since the fork holds its own landing; a second proposal carries only what the fork added since, and lands",
    async () => {
      const w = await projects();
      const lanes = await realObjects(w);
      const one = { ...README, "src/fork-one.ts": "one\n" };
      const own = await landed(lanes.fork, w.fork, one);

      const first = await proposed(w, own, "Add the first fork file");
      await awaitingApproval(first.stub, "p-1");
      const yes = await call(
        w.via,
        w.maintainer.token,
        "POST",
        `/changes/${first.changeId}/proposal/approval`,
        { commit: own },
      );
      expect(yes.status).toBe(200);
      await verified(lanes.up, first.stub, one);
      const two = { ...one, "src/upstream-two.ts": "two\n" };
      const movedOn = await landed(lanes.up, w.upstream, two);

      const owner = await seedUser(uniqueHandle("fay"), { org: POOL_ORG, role: "owner" });
      const synced = await call(w.via, owner.token, "POST", `/projects/${w.fork}/sync`);
      expect(synced).toMatchObject({ status: 200, body: { from: own, synced: true } });
      const merge = String(synced.body["to"]);
      const mergeObject = w.code.repos
        .get(`${projectRepos(w.fork).trunk.namespace}/${projectRepos(w.fork).trunk.name}`)
        ?.objects.get(merge);
      expect(mergeObject === undefined ? [] : decodeCommit(mergeObject.body).parents).toEqual([
        own,
        movedOn,
      ]);

      const three = { ...two, "src/fork-three.ts": "three\n" };
      const added = await landed(lanes.fork, w.fork, three);
      const second = await proposed(w, added, "Add the third fork file");
      expect(await read(second.stub)).toMatchObject({
        baseSha: movedOn,
        intent: { footprint: [{ path: "src/fork-three.ts", op: "create" }] },
      });
      await awaitingApproval(second.stub, "p-1");
      const again = await call(
        w.via,
        w.maintainer.token,
        "POST",
        `/changes/${second.changeId}/proposal/approval`,
        { commit: added },
      );
      expect(again.status).toBe(200);
      expect(await verified(lanes.up, second.stub, three)).toBe(await headOf(w.upstream));
    },
    LONG,
  );
});
