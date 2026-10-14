import { describe, expect, it } from "@effect/vitest";
import {
  type DeployRun,
  runDeployStep,
  SMOKE_BUDGET_MS,
} from "@keeltown/core/application/delivery";
import { workerAppDeployPack } from "@keeltown/core/application/verification";
import {
  DeploymentFailed,
  DeploySpec,
  DeployTarget,
  type SmokeAnswer,
} from "@keeltown/core/domain/delivery";
import { compile, type PlanStep, type StepReport } from "@keeltown/core/domain/verification";
import {
  CommitSha,
  ContentHash,
  type CredentialId,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { CredentialStore, Deployer, DeployTargets, EvidenceStore } from "@keeltown/core/ports";
import {
  freshId,
  makeDeployerMemory,
  makeDeploymentsMemory,
  makeEvidenceStoreMemory,
  makeIdsMemory,
  makePreviewNoticesMemory,
  makeSmokeProbeMemory,
  sampleNamespace,
} from "@keeltown/testing";
import { Effect, Fiber, Layer, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

const TOKEN = "cf-token-SECRET-only-in-a-header";
const PROJECT: ProjectId = freshId("prj");
const CREDENTIAL: CredentialId = makeId("crd", "0".repeat(25) + "1");
const TARGET = Schema.decodeUnknownSync(DeployTarget)({
  name: "production",
  provider: "cloudflare",
  accountId: "0123456789abcdef0123456789abcdef",
  credential: CREDENTIAL,
});
const SPEC = Schema.decodeUnknownSync(DeploySpec)({
  target: "production",
  worker: "worker-lite",
  smoke: [
    { path: "/health", status: 200, contains: "ok" },
    { path: "/", status: 200 },
  ],
});
const PLAN = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    workerAppDeployPack(SPEC),
  ),
);
const stepOf = (id: string): PlanStep => {
  const step = PLAN.steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no ${id}`);
  return step;
};
const BUILD = stepOf("worker-app.build");
const PREVIEW = stepOf("deploy.preview");
const SMOKE = stepOf("deploy.smoke");
const CHANGE = freshId("chg");
const RUN: DeployRun = {
  projectId: PROJECT,
  namespace: sampleNamespace,
  candidateId: freshId("cnd"),
  candidateCommit: CommitSha.make("c".repeat(40)),
  members: [CHANGE],
};
const BUILT = {
  stepId: BUILD.id,
  outcome: "pass",
  why: "built",
  tail: "",
  worker: "worker-lite",
  facts: { compatibilityDate: "2026-10-01", compatibilityFlags: [], vars: { GREETING: "hi" } },
  mainModule: "worker.js",
  bundle: "H4sIAAAAAAAAAytJLS4BAAx+f9gEAAAA",
};

const documentOf = (report: StepReport) =>
  Effect.gen(function* () {
    return yield* (yield* EvidenceStore).get(
      sampleNamespace,
      Schema.decodeUnknownSync(ContentHash)(report.resultRef),
    );
  });

const refusing = (reason: DeploymentFailed["reason"]) =>
  Layer.succeed(
    Deployer,
    Deployer.of({
      preview: () =>
        Effect.fail(
          new DeploymentFailed({
            operation: "preview",
            reason,
            detail: `Cloudflare said ${reason}`,
          }),
        ),
      promote: () => Effect.die("not asked"),
      deleteVersion: () => Effect.die("not asked"),
    }),
  );

/** Every port a deploy step asks, in memory, with the targets and Deployer given. */
const world = (
  options: {
    readonly targets?: readonly DeployTarget[];
    readonly deployer?: Layer.Layer<Deployer>;
    readonly smoke?: (url: string, asked: number) => SmokeAnswer;
  } = {},
) => {
  const deployer = makeDeployerMemory();
  const deployments = makeDeploymentsMemory();
  const notices = makePreviewNoticesMemory();
  const probe = makeSmokeProbeMemory(options.smoke);
  const evidence = makeEvidenceStoreMemory();
  const revealed: CredentialId[] = [];
  const targets = Layer.succeed(
    DeployTargets,
    DeployTargets.of({
      list: () =>
        Effect.succeed(
          (options.targets ?? [TARGET]).map((target) => ({
            target,
            workersDev: "owner.workers.dev",
          })),
        ),
      set: () => Effect.die("not asked"),
      clear: () => Effect.die("not asked"),
    }),
  );
  const credentials = Layer.succeed(
    CredentialStore,
    CredentialStore.of({
      put: () => Effect.die("not asked"),
      list: () => Effect.die("not asked"),
      has: () => Effect.die("not asked"),
      remove: () => Effect.die("not asked"),
      reveal: (_namespace, id) =>
        Effect.sync(() => {
          revealed.push(id);
          return Redacted.make(TOKEN);
        }),
    }),
  );
  const layer = Layer.mergeAll(
    options.deployer ?? deployer.layer,
    deployments.layer,
    notices.layer,
    probe.layer,
    evidence.layer,
    makeIdsMemory().layer,
    targets,
    credentials,
  );
  /** The build's report, its evidence stored as a passing build stores it. */
  const built = Effect.gen(function* () {
    const resultRef = yield* (yield* EvidenceStore).put(sampleNamespace, BUILT);
    const report: StepReport = {
      stepId: BUILD.id,
      outcome: "pass",
      evidenceClass: "proof",
      tier: BUILD.tier,
      durationMs: 1,
      resultRef,
    };
    return report;
  });
  /** Runs build's report, then the preview, then smoke, as a run reaches them. */
  const runAll = Effect.gen(function* () {
    const earlier = new Map<string, StepReport>([[BUILD.id, yield* built]]);
    const preview = yield* runDeployStep(RUN, PREVIEW, earlier);
    earlier.set(PREVIEW.id, preview);
    const smoke = yield* runDeployStep(RUN, SMOKE, earlier);
    return { preview, smoke, earlier };
  });
  return {
    deployer,
    deployments,
    notices,
    probe,
    evidence,
    revealed,
    layer,
    built,
    runAll,
    documentOf,
  };
};

describe("Keel's deploy steps", () => {
  it.effect(
    "[deploy.preview-made] the build goes up as an undeployed version with the change's alias, is recorded for the candidate, and the change is told where it answers",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { preview } = yield* w.runAll;
        expect(preview.outcome).toBe("pass");
        expect(w.revealed).toEqual([CREDENTIAL]);
        expect(w.deployer.calls).toEqual([
          {
            op: "preview",
            account: { accountId: TARGET.accountId, workersDev: "owner.workers.dev" },
            upload: {
              worker: "worker-lite",
              mainModule: "worker.js",
              moduleGzip: BUILT.bundle,
              compatibilityDate: "2026-10-01",
              compatibilityFlags: [],
              vars: { GREETING: "hi" },
              alias: `ch-${CHANGE.slice(-10).toLowerCase()}`,
              tag: RUN.candidateId,
              message: `keel: candidate ${RUN.candidateId}`,
            },
          },
        ]);
        const url = "https://00000001-worker-lite.owner.workers.dev";
        const aliasUrl = `https://ch-${CHANGE.slice(-10).toLowerCase()}-worker-lite.owner.workers.dev`;
        const [deployment] = [...w.deployments.held.values()];
        expect(deployment).toMatchObject({
          target: "production",
          worker: "worker-lite",
          candidateId: RUN.candidateId,
          candidateCommit: RUN.candidateCommit,
          changes: [CHANGE],
          url,
          aliasUrl,
          state: "previewing",
        });
        expect(w.notices.told).toEqual([
          {
            changeId: CHANGE,
            notice: {
              deploymentId: deployment?.id,
              candidateId: RUN.candidateId,
              target: "production",
              url,
              aliasUrl,
            },
          },
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deploy.token-kept-in] the token is in no report, evidence document, record or notice of a preview and its smoke",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { preview, smoke } = yield* w.runAll;
        const documents = [yield* w.documentOf(preview), yield* w.documentOf(smoke)];
        const everything = JSON.stringify({
          reports: [preview, smoke],
          documents,
          held: [...w.deployments.held.values()],
          told: w.notices.told,
          calls: w.deployer.calls,
        });
        expect(everything).toContain("worker-lite");
        expect(everything).not.toContain(TOKEN);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deploy.preview-batch] a candidate of several changes is previewed with no alias, and each change is told its address",
    () => {
      const w = world();
      const other = freshId("chg");
      return Effect.gen(function* () {
        const earlier = new Map<string, StepReport>([[BUILD.id, yield* w.built]]);
        const preview = yield* runDeployStep(
          { ...RUN, members: [CHANGE, other] },
          PREVIEW,
          earlier,
        );
        expect(preview.outcome).toBe("pass");
        expect(
          w.deployer.calls[0]?.op === "preview" && w.deployer.calls[0].upload,
        ).not.toHaveProperty("alias");
        expect(w.notices.told.map((t) => [t.changeId, t.notice.url, t.notice.aliasUrl])).toEqual([
          [CHANGE, "https://00000001-worker-lite.owner.workers.dev", undefined],
          [other, "https://00000001-worker-lite.owner.workers.dev", undefined],
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deploy.no-account] with no account connected for the spec's target the preview and the smoke annotate, nothing is revealed and Cloudflare is not asked",
    () => {
      const w = world({ targets: [] });
      return Effect.gen(function* () {
        const { preview, smoke } = yield* w.runAll;
        expect([preview.outcome, smoke.outcome]).toEqual(["annotate", "annotate"]);
        expect(yield* w.documentOf(preview)).toMatchObject({ skipped: "no-preview-account" });
        expect([w.revealed, w.deployer.calls, w.notices.told, w.probe.asked]).toEqual([
          [],
          [],
          [],
          [],
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deploy.preview-failures] a version Cloudflare refuses fails, cited; a refused token or an unreachable account abstains; a build that did not pass previews nothing",
    () =>
      Effect.gen(function* () {
        const outcomes = [];
        for (const reason of ["refused", "token-refused", "unreachable", "previews-off"] as const) {
          const w = world({ deployer: refusing(reason) });
          const run = yield* Effect.gen(function* () {
            const { preview, smoke } = yield* w.runAll;
            return [reason, preview.outcome, smoke.outcome, yield* w.documentOf(preview)] as const;
          }).pipe(Effect.provide(w.layer));
          outcomes.push(run.slice(0, 3));
          if (reason === "refused")
            expect(run[3]).toMatchObject({
              deploy: { failure: "the preview was not made: Cloudflare said refused" },
            });
          expect([...w.deployments.held.values(), ...w.notices.told]).toEqual([]);
        }
        expect(outcomes).toEqual([
          ["refused", "fail", "abstain"],
          ["token-refused", "abstain", "abstain"],
          ["unreachable", "abstain", "abstain"],
          ["previews-off", "abstain", "abstain"],
        ]);
        const w = world();
        const unbuilt = yield* runDeployStep(RUN, PREVIEW, new Map()).pipe(Effect.provide(w.layer));
        expect([unbuilt.outcome, w.revealed, w.deployer.calls]).toEqual(["abstain", [], []]);
      }),
  );

  it.effect(
    "[deploy.smoke-pass] each check is asked of the preview's address, and all answering as the spec says pass",
    () => {
      const w = world({
        smoke: (url) => ({
          _tag: "answered",
          status: 200,
          body: url.endsWith("/health") ? "ok" : "hi",
        }),
      });
      return Effect.gen(function* () {
        const { smoke } = yield* w.runAll;
        expect(smoke.outcome).toBe("pass");
        expect(w.probe.asked).toEqual([
          "https://00000001-worker-lite.owner.workers.dev/health",
          "https://00000001-worker-lite.owner.workers.dev/",
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[deploy.smoke-retry] a check is asked again while the address is not up, a 404 then a 200 passes, and a redirect is not asked again",
    () =>
      Effect.gen(function* () {
        const coming = world({
          smoke: (_url, asked) =>
            asked < 3
              ? { _tag: "answered", status: 404, body: "" }
              : { _tag: "answered", status: 200, body: "ok" },
        });
        const fiber = yield* Effect.forkChild(coming.runAll.pipe(Effect.provide(coming.layer)));
        yield* TestClock.adjust("30 seconds");
        const { smoke } = yield* Fiber.join(fiber);
        expect(smoke.outcome).toBe("pass");
        expect(coming.probe.asked.filter((u) => u.endsWith("/health"))).toHaveLength(3);
        const moved = world({ smoke: () => ({ _tag: "answered", status: 302, body: "" }) });
        const { smoke: redirected } = yield* moved.runAll.pipe(Effect.provide(moved.layer));
        expect(redirected.outcome).toBe("fail");
        // Each check is asked once: a redirect is an answer, not an address still coming up.
        expect(moved.probe.asked).toEqual([
          "https://00000001-worker-lite.owner.workers.dev/health",
          "https://00000001-worker-lite.owner.workers.dev/",
        ]);
      }),
  );

  it.effect(
    "[deploy.smoke-budget] a preview that never comes up fails once the step's minute is spent, citing what it last answered",
    () =>
      Effect.gen(function* () {
        const down = world({ smoke: () => ({ _tag: "answered", status: 500, body: "boom" }) });
        const fiber = yield* Effect.forkChild(down.runAll.pipe(Effect.provide(down.layer)));
        yield* TestClock.adjust(`${SMOKE_BUDGET_MS * 2} millis`);
        const { smoke } = yield* Fiber.join(fiber);
        expect(smoke.outcome).toBe("fail");
        // The first check spends the minute, one ask every 3 s; the second, past it, is asked once.
        const health = down.probe.asked.filter((u) => u.endsWith("/health")).length;
        expect(health).toBeGreaterThan(1);
        expect(health).toBeLessThanOrEqual(SMOKE_BUDGET_MS / 3000 + 1);
        expect(down.probe.asked.filter((u) => u.endsWith(".dev/"))).toHaveLength(1);
        expect(yield* down.documentOf(smoke).pipe(Effect.provide(down.layer))).toMatchObject({
          deploy: { failure: "GET /health answered 500, not 200" },
        });
        const silent = world({ smoke: () => ({ _tag: "no-answer", error: "connect timeout" }) });
        const quiet = yield* Effect.forkChild(silent.runAll.pipe(Effect.provide(silent.layer)));
        yield* TestClock.adjust(`${SMOKE_BUDGET_MS * 2} millis`);
        const { smoke: never } = yield* Fiber.join(quiet);
        expect(yield* silent.documentOf(never).pipe(Effect.provide(silent.layer))).toMatchObject({
          deploy: { failure: "GET /health never answered: connect timeout" },
        });
      }),
  );
});
