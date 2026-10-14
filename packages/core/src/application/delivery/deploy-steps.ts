import { Clock, Effect, Option, Result, Schema } from "effect";
import {
  type Deployment,
  judgeSmoke,
  PreviewOrigin,
  previewAlias,
  type SmokeJudged,
  smokeRetryable,
  smokeUrl,
} from "../../domain/delivery/index.ts";
import {
  type CandidateId,
  type ChangeId,
  type CommitSha,
  ContentHash,
  type Json,
  type NamespaceId,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import type { InfraFailure, PlanStep, StepReport } from "../../domain/verification/index.ts";
import {
  CredentialStore,
  Deployer,
  Deployments,
  DeployTargets,
  EvidenceStore,
  Ids,
  PreviewNotices,
  SmokeProbe,
} from "../ports/index.ts";
import { DEPLOY_PREVIEW, WORKER_APP_BUILD } from "../verification/index.ts";

/** The candidate a plan's deploy steps run for, as its KeelVerify job names it. */
export interface DeployRun {
  readonly projectId: ProjectId;
  readonly namespace: NamespaceId;
  readonly candidateId: CandidateId;
  /** The candidate's own commit, which trunk must reach for its preview to be deployed. */
  readonly candidateCommit?: CommitSha;
  /** The changes the candidate holds, each told where its preview answers. */
  readonly members: readonly ChangeId[];
}

/** What Keel's deploy steps ask: the account's token, the provider, the project's targets and records, and the changes and previews they tell or ask. */
export type DeployServices =
  | CredentialStore
  | Deployer
  | Deployments
  | DeployTargets
  | EvidenceStore
  | Ids
  | PreviewNotices
  | SmokeProbe;

/** How long a smoke step may spend asking a preview again while its address comes up, across all its checks. */
export const SMOKE_BUDGET_MS = 60_000;
/** How long a smoke step waits before asking a check again. */
export const SMOKE_RETRY_MS = 3_000;

/** What a passing build stored that the preview uploads. */
const BuildDocument = Schema.Struct({
  worker: Schema.String,
  facts: Schema.Struct({
    compatibilityDate: Schema.String,
    compatibilityFlags: Schema.Array(Schema.String),
    vars: Schema.Record(Schema.String, Schema.Json),
  }),
  mainModule: Schema.String,
  bundle: Schema.String,
});

/** What a passing preview stored: where it answers. */
const PreviewDocument = Schema.Struct({ url: Schema.String });

/** The report earlier in this run of the step with this id, as the run kept it. */
export type EarlierReports = ReadonlyMap<string, StepReport>;

const evidenceOf = <A, I>(
  namespace: NamespaceId,
  report: StepReport | undefined,
  schema: Schema.Codec<A, I>,
) =>
  Effect.gen(function* () {
    const ref = Option.getOrUndefined(Schema.decodeUnknownOption(ContentHash)(report?.resultRef));
    if (ref === undefined) return undefined;
    const document = yield* (yield* EvidenceStore)
      .get(namespace, ref)
      .pipe(Effect.catchTag("EvidenceMissing", () => Effect.succeed(undefined)));
    return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(document));
  });

/**
 * Runs one of Keel's own deploy steps for the candidate, in Tier 0, from the
 * spec the plan step carries and what earlier steps of the run stored.
 * `deploy.preview` uploads the build to the target's account as a version
 * that is not deployed and tells each change where it answers;
 * `deploy.smoke` asks it each request the spec names. Each stores its
 * evidence and answers its report; neither fails as an Effect.
 *
 * The token is revealed only here, for the Deployer's call, and never put in
 * a report, an evidence document, a record or an event.
 */
export const runDeployStep = (
  run: DeployRun,
  step: PlanStep,
  earlier: EarlierReports,
): Effect.Effect<StepReport, never, DeployServices> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const store = yield* EvidenceStore;
    const finish = (
      outcome: StepReport["outcome"],
      why: string,
      extra: Readonly<Record<string, Json>> = {},
      failure?: InfraFailure,
    ) =>
      Effect.gen(function* () {
        const resultRef = yield* store.put(run.namespace, {
          stepId: step.id,
          outcome,
          why,
          ...extra,
        });
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        const report: StepReport = {
          stepId: step.id,
          outcome,
          evidenceClass: step.evidenceCeiling,
          tier: step.tier,
          durationMs,
          resultRef,
          ...(failure === undefined ? {} : { failure }),
        };
        return report;
      });
    const abstain = (failure: InfraFailure, why: string) => finish("abstain", why, {}, failure);
    const fail = (failure: string, extra: Readonly<Record<string, Json>> = {}) =>
      finish("fail", failure, { ...extra, deploy: { failure } });
    const spec = step.deploy;
    if (spec === undefined) return yield* abstain("schema", "the plan step carries no deploy spec");

    if (step.id === DEPLOY_PREVIEW.id) {
      const held = yield* (yield* DeployTargets)
        .list(run.projectId)
        .pipe(Effect.catchTag("ProjectNotFound", () => Effect.succeed(undefined)));
      if (held === undefined) return yield* abstain("unavailable", "the project's object is gone");
      const found = held.find((h) => h.target.name === spec.target);
      if (found === undefined)
        return yield* finish(
          "annotate",
          `no-preview-account: no Cloudflare account is connected for the deploy target ${spec.target}, so nothing is previewed`,
          { skipped: "no-preview-account" },
        );
      if (found.workersDev === undefined)
        return yield* abstain(
          "unavailable",
          `the deploy target ${spec.target}'s account has no workers.dev subdomain`,
        );
      const build = yield* evidenceOf(
        run.namespace,
        earlier.get(WORKER_APP_BUILD.id),
        BuildDocument,
      );
      if (build === undefined || earlier.get(WORKER_APP_BUILD.id)?.outcome !== "pass")
        return yield* abstain(
          "unavailable",
          "the build did not pass, so there is nothing to preview",
        );
      const token = yield* (yield* CredentialStore)
        .reveal(run.namespace, found.target.credential)
        .pipe(Effect.catchTag("CredentialMissing", () => Effect.succeed(undefined)));
      if (token === undefined)
        return yield* abstain(
          "unavailable",
          `the deploy target ${spec.target}'s credential is gone: an owner connects the account again`,
        );
      const only = run.members.length === 1 ? run.members[0] : undefined;
      const alias = only === undefined ? undefined : previewAlias(only, spec.worker);
      const made = yield* (yield* Deployer)
        .preview({ accountId: found.target.accountId, workersDev: found.workersDev }, token, {
          worker: spec.worker,
          mainModule: build.mainModule,
          moduleGzip: build.bundle,
          compatibilityDate: build.facts.compatibilityDate,
          compatibilityFlags: build.facts.compatibilityFlags,
          vars: build.facts.vars,
          ...(alias === undefined ? {} : { alias }),
          tag: run.candidateId,
          message: `keel: candidate ${run.candidateId}`,
        })
        .pipe(Effect.result);
      if (Result.isFailure(made))
        return made.failure.reason === "refused"
          ? yield* fail(`the preview was not made: ${made.failure.detail}`)
          : yield* abstain("unavailable", `the preview was not made: ${made.failure.detail}`);
      const deploymentId = yield* (yield* Ids).next("dpl");
      const deployment: Deployment = {
        id: deploymentId,
        target: spec.target,
        worker: spec.worker,
        candidateId: run.candidateId,
        ...(run.candidateCommit === undefined ? {} : { candidateCommit: run.candidateCommit }),
        changes: run.members,
        versionId: made.success.versionId,
        url: made.success.url,
        ...(made.success.aliasUrl === undefined ? {} : { aliasUrl: made.success.aliasUrl }),
        state: "previewing",
        previewedAt: yield* Clock.currentTimeMillis,
      };
      yield* (yield* Deployments)
        .record(run.projectId, deployment)
        .pipe(Effect.catchTag("ProjectNotFound", () => Effect.void));
      const notices = yield* PreviewNotices;
      for (const change of run.members)
        yield* notices.tell(change, {
          deploymentId,
          candidateId: run.candidateId,
          target: spec.target,
          url: made.success.url,
          ...(made.success.aliasUrl === undefined ? {} : { aliasUrl: made.success.aliasUrl }),
        });
      return yield* finish("pass", `previewed ${spec.worker} at ${made.success.url}`, {
        deploymentId,
        target: spec.target,
        worker: spec.worker,
        versionId: made.success.versionId,
        url: made.success.url,
        ...(made.success.aliasUrl === undefined ? {} : { aliasUrl: made.success.aliasUrl }),
      });
    }

    // deploy.smoke
    const previewed = earlier.get(DEPLOY_PREVIEW.id);
    if (previewed?.outcome === "annotate")
      return yield* finish("annotate", "nothing was previewed, so nothing is smoked", {
        skipped: "no-preview-account",
      });
    const preview = yield* evidenceOf(run.namespace, previewed, PreviewDocument);
    if (preview === undefined || previewed?.outcome !== "pass")
      return yield* abstain(
        "unavailable",
        "the preview did not pass, so there is nothing to smoke",
      );
    const origin = Schema.decodeUnknownOption(PreviewOrigin)(preview.url);
    if (Option.isNone(origin))
      return yield* abstain("schema", `the preview's address ${preview.url} is not an origin`);
    const probe = yield* SmokeProbe;
    const deadline = started + SMOKE_BUDGET_MS;
    const judged: SmokeJudged[] = [];
    for (const check of spec.smoke) {
      const address = smokeUrl(origin.value, check);
      if (Result.isFailure(address))
        return yield* fail(`${check.path} would be asked of another host than the preview's`);
      for (;;) {
        const answer = yield* probe.ask(address.success);
        const result = judgeSmoke(check, answer);
        const now = yield* Clock.currentTimeMillis;
        if (result.ok || !smokeRetryable(check, answer) || now + SMOKE_RETRY_MS > deadline) {
          judged.push(result);
          break;
        }
        yield* Effect.sleep(SMOKE_RETRY_MS);
      }
    }
    const checks = judged.map((j) => ({ path: j.path, ok: j.ok, said: j.said }));
    const failed = judged.find((j) => !j.ok);
    return failed === undefined
      ? yield* finish("pass", `${judged.length} smoke checks passed at ${preview.url}`, { checks })
      : yield* fail(failed.said, { checks });
  });
