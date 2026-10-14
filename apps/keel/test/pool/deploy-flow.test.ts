// KeelVerify's deploy steps and Deliver, through the real Worker: the routes
// that store a credential and connect an account, the credential store, the
// real KeelVerify and Deliver Workflows, the Project DO that keeps each
// deployment, a real change's Change DO that is told its preview, the fan-out
// that starts Deliver, and the Cloudflare adapters. Doubled: the runner steps
// a container would answer (the suite, the typecheck and the build, mocked
// with their commands' stdout), the deps steps and the lane's `record`; and
// the network: `fetch` is spied on in this isolate, which is where the
// Workflows' adapters ask it, and every request to api.cloudflare.com or to a
// workers.dev address is answered here and recorded. Anything else it is
// asked for is recorded as a stray, and every case expects none.
import {
  createExecutionContext,
  introspectWorkflowInstance,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { namespaceAddress } from "@keeltown/core/application/coordination";
import {
  namespaceKey,
  SettledVerdict,
  StoredStepReport,
  workerAppDeployPack,
} from "@keeltown/core/application/verification";
import { DeploySpec } from "@keeltown/core/domain/delivery";
import { compile } from "@keeltown/core/domain/verification";
import {
  type CandidateId,
  type ChangeId,
  CommitSha,
  ContentHash,
  EventEnvelope,
  makeId,
  type NamespaceId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { Deployments, EventOutbox, PlanStore } from "@keeltown/core/ports";
import { PLAN_BASE } from "@keeltown/testing";
import { Effect, Result, Schema } from "effect";
import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_API } from "../../src/adapters/driven/deploy/cloudflare-api.ts";
import { DeploymentsRpc } from "../../src/adapters/driven/do-rpc/deployments.ts";
import { FanOutRpc } from "../../src/adapters/driven/do-rpc/fan-out.ts";
import { evidenceKey } from "../../src/adapters/driven/r2/evidence-store.ts";
import { PlanStoreR2 } from "../../src/adapters/driven/r2/plan-store.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { deliverInstanceId, type KeelVerifyJob, keelVerifyParams } from "../../src/rpc/index.ts";
import { buildStdout, suiteStdout, typecheckStdout } from "../support-suite-stdout.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import { mockDepsReady } from "./deps-ready.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  type Fetch,
  placeProject,
  POOL_ORG,
  seedUser,
  uniqueHandle,
} from "./helpers.ts";

const isolate = makeIsolate(env, isolateLayer(env));
/** The app as the isolate composes it, run in this isolate, so the spy on `fetch` is the one its adapters call. */
const app: Fetch = async (url, init) =>
  isolate.app.fetch(new Request(url, init), env, createExecutionContext());

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WORKER = "worker-lite";
/** The version id Cloudflare answers the upload with, and the address it is served at. */
const VERSION = "5a1e7c3d-9b2f-4e8a-8c6d-0f1e2d3c4b5a";
const PREVIEW = `https://${VERSION.slice(0, 8)}-${WORKER}.acme.workers.dev`;
/** The candidate's own commit, which trunk reaches when it lands alone. */
const COMMIT = CommitSha.make("c".repeat(40));

const SPEC = Schema.decodeUnknownSync(DeploySpec)({
  target: "preview",
  worker: WORKER,
  smoke: [{ path: "/health", status: 200, contains: "healthy" }],
});
/** The plan Precheck compiles for a change at a base with SPEC: the suite, the typecheck, then build, preview and smoke. */
const PLAN = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: PLAN_BASE, touchedPaths: ["src/index.ts"], subjects: [], facts: {} },
    workerAppDeployPack(SPEC),
  ),
);
/** The candidate's wrangler.jsonc and the module its build makes. */
const CONFIG = JSON.stringify({
  name: WORKER,
  main: "src/index.ts",
  compatibility_date: "2026-10-01",
  vars: { GREETING: "hi" },
});
const MODULE = 'export default { fetch: () => new Response("healthy") };\n';

interface Answered {
  readonly status: number;
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
  return { status: response.status, json: text === "" ? {} : JSON.parse(text) };
}

const drainNamespace = (namespace: NamespaceId) =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(namespace))));
const projectStub = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

/** A private project of org `pool`, held by its Project DO. */
async function freshProject(): Promise<ProjectId> {
  const projectId = makeId("prj", ulid());
  await placeProject(projectId);
  await establishProject(projectId);
  projectStub(projectId);
  return projectId;
}

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  /** A JSON body as sent. */
  readonly body?: unknown;
  /** A version upload's `metadata` part. */
  readonly metadata?: unknown;
}

/**
 * Cloudflare's API and the workers.dev addresses it serves, doubled: each
 * request recorded with what it carried and answered by `answer`; one to any
 * other host is a stray, and throws.
 */
function cloudflare(answer: (request: Request) => Response) {
  const asked: Asked[] = [];
  const strays: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (
      !request.url.startsWith(`${CLOUDFLARE_API}/`) &&
      !new URL(request.url).hostname.endsWith(".workers.dev")
    ) {
      strays.push(request.url);
      throw new Error(`no fetch to ${request.url} was expected`);
    }
    const type = request.headers.get("content-type") ?? "";
    const metadata = type.startsWith("multipart/form-data")
      ? (await request.clone().formData()).get("metadata")
      : null;
    asked.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      ...(type === "application/json" ? { body: await request.clone().json() } : {}),
      ...(metadata instanceof Blob ? { metadata: JSON.parse(await metadata.text()) } : {}),
    });
    return answer(request);
  });
  return { asked, strays };
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

const ACCOUNT_API = `${CLOUDFLARE_API}/accounts/${ACCOUNT}`;

/**
 * The account as a first preview and a promote meet it: the subdomain is
 * `acme`, no Worker of that name is there yet, an upload is version VERSION,
 * and the preview answers `/health` with `health`.
 */
const account =
  (health: string) =>
  (request: Request): Response => {
    if (request.url === `${PREVIEW}/health`) return new Response(health);
    switch (`${request.method} ${request.url}`) {
      case `GET ${ACCOUNT_API}/workers/subdomain`:
        return envelope(200, { subdomain: "acme" });
      case `GET ${ACCOUNT_API}/workers/workers/${WORKER}`:
        return envelope(404, null, [10_007]);
      case `POST ${ACCOUNT_API}/workers/workers`:
        return envelope(200, { id: "f00d", name: WORKER });
      case `POST ${ACCOUNT_API}/workers/scripts/${WORKER}/versions?bindings_inherit=strict`:
        return envelope(200, { id: VERSION });
      case `POST ${ACCOUNT_API}/workers/scripts/${WORKER}/deployments`:
        return envelope(200, { id: "dep-1" });
      default:
        return envelope(404, null, [7003]);
    }
  };

afterEach(() => {
  vi.restoreAllMocks();
});

/** An owner stores `token` as a credential of org `pool` and connects SPEC's target on a fresh project to it. */
async function connected(token: string): Promise<ProjectId> {
  drainNamespace(POOL_ORG);
  const owner = await seedUser(uniqueHandle("owner"), { role: "owner" });
  const created = await call("/namespaces/pool/credentials", {
    token: owner.token,
    method: "POST",
    body: { label: "ci", provider: "cloudflare", secret: token },
  });
  expect(created.status).toBe(201);
  const projectId = await freshProject();
  const set = await call(`/projects/${projectId}/deploy-targets/${SPEC.target}`, {
    token: owner.token,
    method: "PUT",
    body: { provider: "cloudflare", accountId: ACCOUNT, credential: String(created.json["id"]) },
  });
  expect([set.status, set.json["workersDev"]]).toEqual([200, "acme.workers.dev"]);
  return projectId;
}

/** What the engine's runner step persists: its logs, as the command printed them. */
const runnerOutput = (stdout: string) => ({
  exitCode: 0,
  logs: { stdout, stderr: "" },
  snapshot: { id: "snap", dir: "/workspace", localBucket: true },
});

/** Every step a run persists itself rather than having mocked, by name. */
const PERSISTED = [
  "namespace",
  "plan",
  "js-ts.suite:evidence",
  "worker-app.typecheck:evidence",
  "worker-app.build:evidence",
  "deploy deploy.preview",
  "deploy deploy.smoke",
  "verdict",
] as const;

/**
 * Runs a KeelVerify job for PLAN, stored as Precheck stores it, to its
 * verdict: the deps, the three runner steps (all passing, the build making
 * MODULE) and `record` mocked, every other step run for real. Answers the
 * verdict and each persisted step's result.
 */
async function verify(id: string, job: KeelVerifyJob) {
  await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PlanStore).put(POOL_ORG, PLAN);
    }).pipe(Effect.provide(PlanStoreR2(env.ARCHIVE))),
  );
  await using instance = await introspectWorkflowInstance(env.CI_WORKFLOW, id);
  const runners = {
    "js-ts.suite": runnerOutput(await suiteStdout(3, 0)),
    "worker-app.typecheck": runnerOutput(await typecheckStdout(0, "")),
    "worker-app.build": runnerOutput(await buildStdout(CONFIG, MODULE)),
  };
  await instance.modify(async (m) => {
    await mockDepsReady(m);
    for (const [name, result] of Object.entries(runners)) await m.mockStepResult({ name }, result);
    await m.mockStepResult({ name: "record" }, "recorded");
  });
  await env.CI_WORKFLOW.create({ id, params: keelVerifyParams(job) });
  const verdict = await instance.waitForStepResult({ name: "verdict" });
  await instance.waitForStatus("complete");
  // Complete, so every step that ran has kept its result: one that never ran reads as undefined, not waited on.
  const steps: Record<string, unknown> = Object.fromEntries(
    await Promise.all(
      PERSISTED.map(async (name) => [
        name,
        await Promise.race([
          instance.waitForStepResult({ name }),
          new Promise((resolve) => setTimeout(resolve, 1_000, undefined)),
        ]),
      ]),
    ),
  );
  return {
    // The step persists the verdict as JSON, since a next action's args are open.
    verdict: Schema.decodeUnknownSync(SettledVerdict)(JSON.parse(String(verdict))),
    steps,
  };
}

const job = (
  projectId: ProjectId,
  candidateId: CandidateId,
  extra: Pick<KeelVerifyJob, "members" | "candidateCommit"> = {},
): KeelVerifyJob => ({
  projectId,
  namespace: POOL_ORG,
  jobId: `job-${candidateId}`,
  laneId: `lane:${projectId}:main`,
  candidateId,
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"d".repeat(64)}`),
  fence: { batchId: makeId("bat", ulid()), attempt: 1, chainEpoch: 0 },
  planHash: PLAN.planHash,
  ...extra,
});

type Reported = typeof StoredStepReport.Type;

/** A deploy step's report, as its durable step persisted it. */
const reportOf = (steps: Record<string, unknown>, name: string): Reported =>
  Schema.decodeUnknownSync(StoredStepReport)(JSON.parse(String(steps[name])));

/** The evidence document a report cites, from ARCHIVE. */
async function evidenceOf(report: Reported): Promise<unknown> {
  const ref = Schema.decodeUnknownSync(ContentHash)(report.resultRef);
  const stored = await env.ARCHIVE.get(evidenceKey(POOL_ORG, ref));
  return stored === null ? null : await stored.json();
}

/** Every evidence document org `pool` holds in ARCHIVE, by key, as stored. */
async function archivedEvidence(): Promise<ReadonlyMap<string, string>> {
  const held = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await env.ARCHIVE.list({
      prefix: namespaceKey(POOL_ORG, "evidence", ""),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const texts = await Promise.all(
      page.objects.map(async (object) => (await env.ARCHIVE.get(object.key))?.text()),
    );
    page.objects.forEach((object, i) => {
      const text = texts[i];
      if (text !== undefined) held.set(object.key, text);
    });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return held;
}

/** The project entity's events, in `seq` order. */
const projectLog = (projectId: ProjectId) =>
  runInDurableObject(projectStub(projectId), (instance: ProjectDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "project", id: projectId })),
    ),
  );

/** The deployment the project's object keeps for the candidate, read as Deliver reads it. */
const deploymentOf = (projectId: ProjectId, candidateId: CandidateId) =>
  Effect.runPromise(
    Deployments.use((deployments) => deployments.of(projectId, candidateId)).pipe(
      Effect.provide(DeploymentsRpc((id) => projectStub(id))),
    ),
  );

/**
 * The run cases 1, 4, 5 and 6 share: a connected project, a real change
 * declared on it, and a KeelVerify job for one candidate holding that change
 * at COMMIT, its preview answering `/health` with "healthy". Run once, by
 * whichever of them runs first.
 */
async function previewAndSmoke() {
  const token = `cf-token-${crypto.randomUUID()}`;
  const cf = cloudflare(account("healthy"));
  const projectId = await connected(token);
  const change = await changeUnderTest(projectId);
  ok(await change.declare());
  const candidateId = makeId("cnd", ulid());
  const ran = await verify(
    "deploy-flow-land",
    job(projectId, candidateId, { members: [change.changeId], candidateCommit: COMMIT }),
  );
  return {
    ...ran,
    ...cf,
    token,
    projectId,
    candidateId,
    change,
    changeLog: await change.log(),
    projectLog: await projectLog(projectId),
    evidence: await archivedEvidence(),
  };
}
let landedRun: ReturnType<typeof previewAndSmoke> | undefined;
const landed = () => (landedRun ??= previewAndSmoke());

/** A change's preview alias, `ch-` and its id's tail, and the address it answers at, before the Worker's name. */
const aliasOf = (changeId: ChangeId) => `ch-${changeId.slice(-10).toLowerCase()}`;
const aliasUrlOf = (changeId: ChangeId) =>
  `https://${aliasOf(changeId)}-${WORKER}.acme.workers.dev`;

describe("a candidate's preview, through KeelVerify", () => {
  it("[cf.pool.preview-smoke-land] on a connected account the build is uploaded as a version, its smoke passes and the candidate lands: the Project DO keeps its deployment, and the change's agent is told where it answers", async () => {
    const run = await landed();
    expect(run.strays).toEqual([]);
    expect(run.verdict.outcome).toBe("land");
    expect(
      [
        reportOf(run.steps, "deploy deploy.preview"),
        reportOf(run.steps, "deploy deploy.smoke"),
      ].map((r) => [r.stepId, r.outcome]),
    ).toEqual([
      ["deploy.preview", "pass"],
      ["deploy.smoke", "pass"],
    ]);
    // The target's reach check, then a first preview: no Worker yet, so one is made, then the version, then its smoke.
    expect(run.asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      `GET ${ACCOUNT_API}/workers/subdomain`,
      `GET ${ACCOUNT_API}/workers/workers/${WORKER}`,
      `POST ${ACCOUNT_API}/workers/workers`,
      `POST ${ACCOUNT_API}/workers/scripts/${WORKER}/versions?bindings_inherit=strict`,
      `GET ${PREVIEW}/health`,
    ]);
    expect(run.asked[3]?.metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: [],
      bindings: [{ type: "plain_text", name: "GREETING", text: "hi" }],
      annotations: {
        "workers/message": `keel: candidate ${run.candidateId}`,
        "workers/tag": run.candidateId,
        "workers/alias": aliasOf(run.change.changeId),
      },
    });
    const kept = await deploymentOf(run.projectId, run.candidateId);
    expect(kept).toMatchObject({
      target: SPEC.target,
      worker: WORKER,
      candidateId: run.candidateId,
      candidateCommit: COMMIT,
      changes: [run.change.changeId],
      versionId: VERSION,
      url: PREVIEW,
      aliasUrl: aliasUrlOf(run.change.changeId),
      state: "previewing",
    });
    const told = run.changeLog.filter((e) => e.type === "PreviewDeployed");
    expect(told.map((e) => [e.payload, e.notified])).toEqual([
      [
        expect.objectContaining({
          deploymentId: kept?.id,
          changeId: run.change.changeId,
          candidateId: run.candidateId,
          target: SPEC.target,
          provider: "cloudflare",
          url: PREVIEW,
          aliasUrl: aliasUrlOf(run.change.changeId),
        }),
        expect.arrayContaining([`agent:${run.change.agentId}`]),
      ],
    ]);
  });

  it('[cf.pool.preview-broken-bounces] a preview that answers /health 200 without "healthy" bounces the candidate, citing the smoke check', async () => {
    const cf = cloudflare(account("broken"));
    const projectId = await connected(`cf-token-${crypto.randomUUID()}`);
    const { verdict, steps } = await verify(
      "deploy-flow-broken",
      job(projectId, makeId("cnd", ulid()), { candidateCommit: COMMIT }),
    );
    expect(cf.strays).toEqual([]);
    expect(reportOf(steps, "deploy deploy.smoke").outcome).toBe("fail");
    expect(verdict.outcome).toBe("bounce");
    expect(verdict.evidence).toContain(
      'deploy check failed: deploy.smoke: GET /health answered 200 without "healthy"',
    );
    // Answered, so not asked again: only a 404, a 5xx or no answer is retried.
    expect(cf.asked.filter((a) => a.url === `${PREVIEW}/health`)).toHaveLength(1);
  });

  it("[cf.pool.no-target-annotates] a project with no deploy target previews nothing: both deploy steps annotate no-preview-account, Cloudflare is never asked, and the candidate lands", async () => {
    const cf = cloudflare(account("healthy"));
    const projectId = await freshProject();
    const { verdict, steps } = await verify(
      "deploy-flow-no-target",
      job(projectId, makeId("cnd", ulid()), { candidateCommit: COMMIT }),
    );
    const preview = reportOf(steps, "deploy deploy.preview");
    const smoke = reportOf(steps, "deploy deploy.smoke");
    expect([preview.outcome, smoke.outcome]).toEqual(["annotate", "annotate"]);
    expect(await evidenceOf(preview)).toMatchObject({
      skipped: "no-preview-account",
      why: expect.stringMatching(/^no-preview-account: /),
    });
    expect(await evidenceOf(smoke)).toMatchObject({ skipped: "no-preview-account" });
    expect([cf.asked, cf.strays]).toEqual([[], []]);
    expect(verdict.outcome).toBe("land");
  });

  it("[cf.pool.token-nowhere] the account's token is in the authorization header of each request to Cloudflare's API and nowhere else: not the preview's, no persisted step result, no evidence document, no event", async () => {
    const run = await landed();
    const api = run.asked.filter((a) => a.url.startsWith(`${CLOUDFLARE_API}/`));
    expect(api.length).toBeGreaterThan(0);
    expect(new Set(api.map((a) => a.authorization))).toEqual(new Set([`Bearer ${run.token}`]));
    expect(run.asked.filter((a) => a.url.startsWith(PREVIEW)).map((a) => a.authorization)).toEqual([
      null,
    ]);
    for (const name of PERSISTED)
      expect([name, String(run.steps[name]).includes(run.token)]).toEqual([name, false]);
    // The run's own documents are among those read: the preview's evidence, at least.
    const preview = Schema.decodeUnknownSync(ContentHash)(
      reportOf(run.steps, "deploy deploy.preview").resultRef,
    );
    expect(run.evidence.has(evidenceKey(POOL_ORG, preview))).toBe(true);
    for (const [key, text] of run.evidence)
      expect([key, text.includes(run.token)]).toEqual([key, false]);
    expect(run.changeLog.some((e) => e.type === "PreviewDeployed")).toBe(true);
    expect(run.projectLog.some((e) => e.type === "DeployTargetSet")).toBe(true);
    for (const event of [...run.changeLog, ...run.projectLog])
      expect([event.type, JSON.stringify(event).includes(run.token)]).toEqual([event.type, false]);
  });
});

/** A TrunkAdvanced to `to` on the project, landing the candidate (and its change) alone. */
const advanced = (
  projectId: ProjectId,
  to: CommitSha,
  landing: { readonly candidateId: CandidateId; readonly changeId: ChangeId },
) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: "TrunkAdvanced",
    entity: { kind: "trunk", id: projectId },
    seq: 1,
    at: Date.now(),
    dedupeKey: `trunk:${projectId}/advance-${to}/TrunkAdvanced#1`,
    project: projectId,
    affected: [],
    notified: [],
    payload: {
      _tag: "TrunkAdvanced",
      projectId,
      from: PLAN_BASE,
      to,
      groupId: "grp",
      landings: [{ ...landing, commitSha: to, proofId: "proof" }],
    },
  });

/** Delivers the events to Deliver's subscription, as a Trunk DO's outbox does. */
const deliver = (events: readonly EventEnvelope[]) =>
  Effect.runPromise(FanOutRpc(env).deliver("workflow:Deliver", events));

describe("trunk, deployed by Deliver", () => {
  it("[cf.pool.deliver-promotes] a TrunkAdvanced to the candidate's commit starts Deliver, which promotes the previewed version to all traffic and commits DeploymentPromoted; delivered again, it starts nothing and promotes nothing more", async () => {
    const run = await landed();
    const preview = await deploymentOf(run.projectId, run.candidateId);
    if (preview === undefined) throw new Error("the candidate's preview is not kept");
    projectStub(run.projectId);
    const cf = cloudflare(account("healthy"));
    const event = advanced(run.projectId, COMMIT, {
      candidateId: run.candidateId,
      changeId: run.change.changeId,
    });
    const id = deliverInstanceId(run.projectId, COMMIT);
    {
      // Held open across both deliveries: disposing the introspector frees the instance's id.
      await using instance = await introspectWorkflowInstance(env.DELIVER, id);
      await deliver([event]);
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "deliver" })).toEqual({
        _tag: "Promoted",
        deploymentId: preview.id,
      });
      await deliver([event]);
      // A second run would have answered AlreadyPromoted: the instance is still the first one's.
      expect(await (await env.DELIVER.get(id)).status()).toMatchObject({
        status: "complete",
        output: { _tag: "Promoted", deploymentId: preview.id },
      });
    }
    expect(cf.strays).toEqual([]);
    expect(cf.asked).toEqual([
      {
        method: "POST",
        url: `${ACCOUNT_API}/workers/scripts/${WORKER}/deployments`,
        authorization: `Bearer ${run.token}`,
        body: {
          strategy: "percentage",
          versions: [{ version_id: VERSION, percentage: 100 }],
          annotations: { "workers/message": `keel: trunk ${COMMIT}` },
        },
      },
    ]);
    expect(await deploymentOf(run.projectId, run.candidateId)).toMatchObject({
      id: preview.id,
      state: "promoted",
      promotedTo: COMMIT,
    });
    const promoted = (await projectLog(run.projectId)).filter(
      (e) => e.type === "DeploymentPromoted",
    );
    expect(promoted.map((e) => e.payload)).toEqual([
      {
        _tag: "DeploymentPromoted",
        deploymentId: preview.id,
        trunkSha: COMMIT,
        target: SPEC.target,
        provider: "cloudflare",
        stage: "production",
      },
    ]);
  });

  it("[cf.pool.deliver-commit-differs] a TrunkAdvanced to another commit than the one previewed is refused commit-differs on the project, and Cloudflare is never asked", async () => {
    const run = await landed();
    projectStub(run.projectId);
    const cf = cloudflare(account("healthy"));
    const other = CommitSha.make("d".repeat(40));
    {
      await using instance = await introspectWorkflowInstance(
        env.DELIVER,
        deliverInstanceId(run.projectId, other),
      );
      await deliver([
        advanced(run.projectId, other, {
          candidateId: run.candidateId,
          changeId: run.change.changeId,
        }),
      ]);
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "deliver" })).toEqual({
        _tag: "Refused",
        reason: "commit-differs",
      });
    }
    const refused = (await projectLog(run.projectId)).filter((e) => e.type === "DeliveryRefused");
    expect(refused.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        _tag: "DeliveryRefused",
        projectId: run.projectId,
        trunkSha: other,
        candidateId: run.candidateId,
        reason: "commit-differs",
      }),
    ]);
    expect([cf.asked, cf.strays]).toEqual([[], []]);
  });
});
