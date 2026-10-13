import {
  type CandidateId,
  type ChangeId,
  CommitSha,
  ContentHash,
  makeId,
  type NamespaceId,
  type VerdictId,
} from "@keeltown/core/kernel";
import {
  ChangeNotFound,
  type ChangeState,
  ChangeStateRefused,
} from "@keeltown/core/domain/coordination";
import { CandidateNotFound, ResultFenced } from "@keeltown/core/domain/integration";
import {
  BundleMissing,
  type AdmittedGuard,
  ModelAbstained,
  type StepResult,
  type VerificationJob,
} from "@keeltown/core/domain/verification";
import {
  AdmittedGuards,
  type BatchVerdict,
  BatchVerdicts,
  ChangePrecheck,
  commit,
  type DecisionRequest,
  type Transition,
  type DecisionResponse,
  DecisionModel,
  DepsBuilder,
  FlowSpecSource,
  type GuardRefused,
  ObjectNotFound,
  type PlatformFunctionCall,
  PlatformFunction,
  type PrecheckCall,
  type PrecheckWorkspace,
  ProbeRunner,
  type ProbeRunRequest,
  ProbeRunnerUnavailable,
  ProbeStore,
  VerifierRuntime,
  type WorldReadiness,
} from "@keeltown/core/ports";
import {
  DEPS_TOOLCHAIN,
  type DepsAnswer,
  depsNeedFrom,
  type DepsPointer,
  guardFileText,
  type Locked,
  namespaceKey,
  pointerServes,
  type ProbeFile,
  type ProbeRun,
  readGuardFile,
} from "@keeltown/core/application/verification";
import { Effect, Layer, Result, Schema } from "effect";
import type {
  AdmittedGuardsHarness,
  DepsBuilderHarness,
  FlowSpecSourceHarness,
  ProbeRunnerHarness,
  ProbeStoreHarness,
} from "../contracts/verification.ts";
import { makeEventOutboxMemory } from "./event-outbox.ts";
import { makeClockMemory } from "./identity.ts";
import { sampleNamespace } from "../namespaces.ts";

/**
 * A scripted decision model. Without a script every question is answered
 * `unclear` with certainty, which is the safe answer: opinion that routes
 * nothing.
 */
export function makeDecisionModelMemory(
  script?: (request: DecisionRequest) => DecisionResponse | "abstain",
) {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    layer: Layer.succeed(
      DecisionModel,
      DecisionModel.of({
        ask: (request) =>
          Effect.suspend(() => {
            asked.push(request);
            const answer = script?.(request) ?? {
              model: "scripted",
              answers: request.questions.map((q) => ({
                questionId: q.id,
                probabilities: { unclear: 1 },
              })),
            };
            return answer === "abstain"
              ? Effect.fail(new ModelAbstained({ reason: "unavailable" }))
              : Effect.succeed(answer);
          }),
      }),
    ),
  };
}

export function makePlatformFunctionMemory(responses: Readonly<Record<string, unknown>> = {}) {
  const calls: PlatformFunctionCall[] = [];
  return {
    calls,
    layer: Layer.succeed(
      PlatformFunction,
      PlatformFunction.of({
        call: (call) =>
          Effect.suspend(() => {
            calls.push(call);
            return call.name in responses
              ? Effect.succeed(responses[call.name])
              : Effect.fail(new ModelAbstained({ reason: "unavailable" }));
          }),
      }),
    ),
  };
}

/** Every step passes at Tier 0 unless `outcome` says otherwise. */
export function makeVerifierRuntimeMemory(
  outcome?: (step: VerificationJob["steps"][number]) => StepResult["outcome"],
) {
  const jobs: VerificationJob[] = [];
  const namespaces: NamespaceId[] = [];
  const handed: DepsAnswer[] = [];
  return {
    jobs,
    /** The namespace each job was run for, in the order of `jobs`. */
    namespaces,
    /** The deps each job was handed, in the order of `jobs`. */
    handed,
    layer: Layer.succeed(
      VerifierRuntime,
      VerifierRuntime.of({
        run: (namespace, job, deps) =>
          Effect.sync(() => {
            jobs.push(job);
            namespaces.push(namespace);
            handed.push(deps);
            return job.steps.map((step) => ({
              stepId: step.id,
              outcome: outcome?.(step) ?? "pass",
              evidenceClass: step.evidenceCeiling,
              tier: step.tier,
              durationMs: 0,
            }));
          }),
      }),
    ),
  };
}

/**
 * FlowSpecSource over commits held in memory: `commit` files a set of paths
 * under a fresh repo and commit id, and `read` answers them as the CodeHost
 * adapter would read them from a tree.
 */
export function makeFlowSpecSourceMemory(): FlowSpecSourceHarness {
  const commits = new Map<string, Readonly<Record<string, string>>>();
  let n = 0;
  return {
    layer: Layer.succeed(
      FlowSpecSource,
      FlowSpecSource.of({
        read: (repo, base) => {
          const files = commits.get(`${repo.namespace}/${repo.name}@${base}`);
          if (files === undefined) return Effect.fail(new ObjectNotFound({ repo, oid: base }));
          const paths = Object.keys(files);
          return Effect.succeed({
            rootPaths: [...new Set(paths.map((p) => p.split("/")[0] ?? p))],
            ...(files[".keel/flow.json"] === undefined
              ? {}
              : { flowJson: files[".keel/flow.json"] }),
            ...(files["package.json"] === undefined ? {} : { packageJson: files["package.json"] }),
          });
        },
      }),
    ),
    commit: (files) =>
      Effect.sync(() => {
        n += 1;
        const repo = { namespace: "memory", name: `flow-${n}` };
        const base = CommitSha.make(n.toString(16).padStart(40, "0"));
        commits.set(`${repo.namespace}/${repo.name}@${base}`, files);
        return { repo, base };
      }),
  };
}

/**
 * Admitted guards per project, as the guard repo holds them: each guard's
 * guard.json as admission commits it, read back as the CodeHost adapter
 * reads it (the proposition its tenet), and each guard whose guard.json
 * cannot be admitted to a plan, with its reason. Each admission is a commit
 * with a deterministic id; admitting a guard the repo already holds as
 * written answers the head, the last admission's commit.
 */
export function makeAdmittedGuardsMemory(): AdmittedGuardsHarness {
  const projects = new Map<
    string,
    {
      readonly admitted: readonly { readonly text: string; readonly commit: CommitSha }[];
      readonly refused: readonly GuardRefused[];
    }
  >();
  let commits = 0;
  const of = (projectId: string) => projects.get(projectId) ?? { admitted: [], refused: [] };
  return {
    plantWithoutProposition: (projectId, guardId) =>
      Effect.sync(() => {
        const list = of(projectId);
        projects.set(projectId, {
          ...list,
          refused: [...list.refused, { guardId, reason: "guard.json names no proposition" }],
        });
      }),
    layer: Layer.succeed(
      AdmittedGuards,
      AdmittedGuards.of({
        list: (projectId) =>
          Effect.sync(() => {
            const list = of(projectId);
            const admitted: AdmittedGuard[] = [];
            const refused = [...list.refused];
            for (const { text } of list.admitted) {
              const guardId = String(readGuardId(text));
              const read = readGuardFile(guardId, text);
              if (Result.isSuccess(read)) admitted.push(read.success);
              else refused.push({ guardId, reason: read.failure });
            }
            return { admitted, refused };
          }),
        admit: (projectId, guard) =>
          Effect.gen(function* () {
            const list = of(projectId);
            const text = guardFileText(guard);
            const held = list.admitted.find((g) => readGuardId(g.text) === guard.guardId);
            if (held !== undefined)
              return held.text === text
                ? (list.admitted.at(-1)?.commit ?? held.commit)
                : yield* Effect.die(
                    new Error(`${guard.guardId} is already admitted as another guard`),
                  );
            commits += 1;
            const sha = CommitSha.make(commits.toString(16).padStart(40, "0"));
            projects.set(projectId, {
              ...list,
              admitted: [...list.admitted, { text, commit: sha }],
            });
            return sha;
          }),
      }),
    ),
  };
}

const readGuardId = (text: string): unknown => Reflect.get(Object(JSON.parse(text)), "guardId");

/** A batch as the in-memory lane knows it: its members, its candidate, and the attempt and epoch results are fenced on. */
export interface LaneBatch {
  readonly members: readonly ChangeId[];
  readonly candidateId: CandidateId;
  readonly attempt: number;
  readonly chainEpoch: number;
}

/**
 * The lane side of `BatchVerdicts`, in memory: what the Lane DO's
 * `recordVerdict` does, so KeelVerify can be driven before it exists. One
 * commit per instance (cause `<instanceId>:recordVerdict`) appends
 * VerdictIssued and BatchVerified for a land, or BatchFailed otherwise. A
 * failure is attributed as the lane does at L1: a batch of one to its change,
 * a larger one `unattributed`; a verdict that is not a bounce (an abstaining
 * runner parks) is `infra`, which requeues without blame.
 */
export function makeBatchVerdictsMemory(batches: ReadonlyMap<string, LaneBatch> = new Map()) {
  const outbox = makeEventOutboxMemory();
  const clock = makeClockMemory();
  const recorded: { laneId: string; verdict: BatchVerdict }[] = [];
  const record = (laneId: string, v: BatchVerdict) =>
    commit(
      { entity: { kind: "batch", id: v.fence.batchId }, cause: `${v.instanceId}:recordVerdict` },
      (): Result.Result<Transition<undefined>, CandidateNotFound | ResultFenced> => {
        const batch = batches.get(v.fence.batchId);
        if (batch === undefined || batch.candidateId !== v.candidateId)
          return Result.fail(new CandidateNotFound({ candidateId: v.candidateId }));
        if (batch.attempt !== v.fence.attempt || batch.chainEpoch !== v.fence.chainEpoch)
          return Result.fail(new ResultFenced(v.fence));
        recorded.push({ laneId, verdict: v });
        const issued = {
          _tag: "VerdictIssued",
          verdictId: v.verdictId,
          subject: v.fence.batchId,
          outcome: v.outcome,
          evidence: [...v.evidence],
          planHash: v.planHash,
        };
        const settled =
          v.outcome === "land"
            ? {
                _tag: "BatchVerified",
                batchId: v.fence.batchId,
                candidateId: v.candidateId,
                verdictId: v.verdictId,
              }
            : {
                _tag: "BatchFailed",
                batchId: v.fence.batchId,
                candidateId: v.candidateId,
                verdictId: v.verdictId,
                attribution:
                  v.outcome !== "bounce"
                    ? "infra"
                    : batch.members.length === 1 && batch.members[0] !== undefined
                      ? batch.members[0]
                      : "unattributed",
              };
        return Result.succeed({
          drafts: [{ payload: issued }, { payload: settled }],
          value: undefined,
        });
      },
    ).pipe(Effect.asVoid, Effect.provide(outbox.layer), Effect.provide(clock.layer));
  return {
    recorded,
    outbox,
    layer: Layer.succeed(BatchVerdicts, BatchVerdicts.of({ record })),
  };
}

/** A change as Precheck sees it in memory: its revision, state and workspace, and the calls it took. */
interface PrecheckedChange {
  revision: number;
  state: ChangeState;
  readonly workspace: PrecheckWorkspace | undefined;
  readonly replies: Map<string, VerdictId | undefined>;
  /** Whether the current Precheck pass has recorded its derivation: one a pass. */
  derived: boolean;
}

/**
 * The Change DO's side of `ChangePrecheck`, in memory: the transitions its
 * machine takes (submitted → deriving on `started`, there one derivation a
 * pass on `derived`, then bounced on `refused`, or on `compiled` verifying
 * and, with no step before the queue at L1, queued in the same commit),
 * idempotent by instance, and ChangeStateRefused for a stale revision or a
 * step the state does not allow.
 * `submit` seeds a change; `calls` lists the writes that took effect.
 */
export function makeChangePrecheckMemory() {
  const changes = new Map<ChangeId, PrecheckedChange>();
  let verdicts = 0;
  const calls: { changeId: ChangeId; method: string; call: PrecheckCall }[] = [];
  const known = (changeId: ChangeId) => {
    const change = changes.get(changeId);
    return change === undefined
      ? Effect.fail(new ChangeNotFound({ changeId }))
      : Effect.succeed(change);
  };
  const refusedBy = (changeId: ChangeId, change: PrecheckedChange, command: string) =>
    new ChangeStateRefused({ changeId, state: change.state, command });
  /** One write: a replay answers what the first did; otherwise `from` must hold at `call.revision`. */
  const write = (
    changeId: ChangeId,
    method: string,
    call: PrecheckCall,
    from: ChangeState,
    to: ChangeState,
    reply: () => VerdictId | undefined,
  ) =>
    Effect.flatMap(known(changeId), (change) => {
      const key = `${call.instanceId}:${method}`;
      if (change.replies.has(key)) return Effect.succeed(change.replies.get(key));
      if (call.revision !== change.revision || change.state !== from)
        return Effect.fail(refusedBy(changeId, change, method));
      const answer = reply();
      change.replies.set(key, answer);
      change.state = to;
      // A pass starts with no derivation, and records at most one.
      if (method === "precheckStarted") change.derived = false;
      if (method === "effectsDerived") change.derived = true;
      calls.push({ changeId, method, call });
      return Effect.succeed(answer);
    });
  return {
    calls,
    /** Seeds `changeId` as submitted at `revision`, holding `workspace` (none: it holds none yet). */
    submit: (changeId: ChangeId, revision: number, workspace?: PrecheckWorkspace) => {
      changes.set(changeId, {
        revision,
        state: "submitted",
        workspace,
        replies: new Map(),
        derived: false,
      });
    },
    /** The change's state, for a test to read. */
    stateOf: (changeId: ChangeId) => changes.get(changeId)?.state,
    layer: Layer.succeed(
      ChangePrecheck,
      ChangePrecheck.of({
        workspace: (changeId) =>
          Effect.flatMap(known(changeId), (change) =>
            change.workspace === undefined
              ? Effect.fail(refusedBy(changeId, change, "workspace"))
              : Effect.succeed(change.workspace),
          ),
        started: (changeId, call) =>
          write(changeId, "precheckStarted", call, "submitted", "deriving", () => undefined).pipe(
            Effect.asVoid,
          ),
        derived: (changeId, derived) =>
          Effect.flatMap(known(changeId), (change) =>
            change.derived && !change.replies.has(`${derived.instanceId}:effectsDerived`)
              ? Effect.fail(refusedBy(changeId, change, "DeriveEffects"))
              : write(changeId, "effectsDerived", derived, "deriving", "deriving", () => undefined),
          ).pipe(Effect.asVoid),
        refused: (changeId, refusal) =>
          write(changeId, "precheckRefused", refusal, "deriving", "bounced", () =>
            makeId("vrd", String((verdicts += 1)).padStart(26, "0")),
          ).pipe(
            Effect.flatMap((verdictId) =>
              verdictId === undefined
                ? Effect.die("a refusal always issues a verdict")
                : Effect.succeed(verdictId),
            ),
          ),
        compiled: (changeId, plan) =>
          write(changeId, "planCompiled", plan, "deriving", "queued", () => undefined).pipe(
            Effect.asVoid,
          ),
      }),
    ),
  };
}

/**
 * Probe runs answered from a script: what the probe reports for each request,
 * or `unavailable` for a runner that could not run it. Every request is kept,
 * so a test can see which worlds and runs were asked for. A world bundle is
 * ready unless `unready` names why not.
 */
export function makeProbeRunnerMemory(
  answer: (request: ProbeRunRequest) => ProbeRun | "unavailable",
  unready: (worldBundle: ContentHash) => string | undefined = () => undefined,
) {
  const requests: ProbeRunRequest[] = [];
  return {
    requests,
    layer: Layer.succeed(
      ProbeRunner,
      ProbeRunner.of({
        ready: ({ worldBundle }) =>
          Effect.sync((): WorldReadiness => {
            const reason = unready(worldBundle);
            return reason === undefined ? { _tag: "Ready" } : { _tag: "Unready", reason };
          }),
        run: (request) =>
          Effect.suspend(() => {
            requests.push(request);
            const answered = answer(request);
            return answered === "unavailable"
              ? Effect.fail(new ProbeRunnerUnavailable({ reason: "scripted: unavailable" }))
              : Effect.succeed(answered);
          }),
      }),
    ),
  };
}

const probeHash = (i: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(i).padStart(64, "0")}`);

const probeRequest = (i: number): ProbeRunRequest => ({
  namespace: sampleNamespace,
  probe: probeHash(i),
  world: "A",
  worldBundle: probeHash(9),
  run: 1,
});

/** The contract's harness over the memory runner: one probe per prepared answer. */
export function memoryProbeRunnerHarness(): ProbeRunnerHarness {
  const prepared = {
    pass: probeRequest(0),
    fail: probeRequest(1),
    "n/a": probeRequest(2),
    "harness-error": probeRequest(3),
  };
  const runner = makeProbeRunnerMemory((r): ProbeRun | "unavailable" => {
    if (r.probe === prepared["harness-error"].probe)
      return {
        _tag: "harness-error",
        reason: "expected exactly one probe test, found 0",
        observations: [],
      };
    const outcome = (["pass", "fail", "n/a"] as const).find((k) => prepared[k].probe === r.probe);
    return outcome === undefined
      ? "unavailable"
      : { _tag: "ran", outcome, reason: outcome, observations: ["observed"] };
  });
  return { layer: runner.layer, prepared };
}

/** Where the memory ProbeStore keeps a namespace's probe: the key the R2 adapter keeps its bundle at. */
const probeKeyOf = (namespace: NamespaceId, hash: ContentHash) =>
  namespaceKey(namespace, "bundles", hash.slice("sha256:".length));

/**
 * Probes kept as files, under the sha256 of their canonical JSON (the files
 * sorted by path), so the hash is as stable as a bundle's, at the key the R2
 * adapter keeps a namespace's bundles at.
 */
export function makeProbeStoreMemory(): ProbeStoreHarness & {
  readonly stored: ReadonlyMap<string, readonly ProbeFile[]>;
} {
  const stored = new Map<string, readonly ProbeFile[]>();
  return {
    stored,
    read: (namespace, hash) => Effect.sync(() => stored.get(probeKeyOf(namespace, hash))),
    layer: Layer.succeed(
      ProbeStore,
      ProbeStore.of({
        put: (namespace, files) =>
          Effect.promise(async () => {
            const sorted = files.toSorted((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
            );
            const canonical = new TextEncoder().encode(
              JSON.stringify(sorted.map((f) => [f.path, f.text])),
            );
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", canonical));
            const hash = Schema.decodeUnknownSync(ContentHash)(
              `sha256:${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
            );
            stored.set(probeKeyOf(namespace, hash), sorted);
            return hash;
          }),
        get: (namespace, hash) => {
          const files = stored.get(probeKeyOf(namespace, hash));
          return files === undefined
            ? Effect.fail(new BundleMissing({ hash }))
            : Effect.succeed(files);
        },
      }),
    ),
  };
}

const hexOf = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Where a namespace's candidate bundle is kept: the key the R2 adapter keeps it at. */
const bundleKeyOf = (namespace: NamespaceId, bundle: ContentHash) =>
  namespaceKey(namespace, "bundles", bundle.slice("sha256:".length));

/** One deps build the memory builder ran. */
export interface DepsBuilt {
  readonly namespace: NamespaceId;
  readonly need: Locked;
  readonly bundle: ContentHash;
}

/**
 * DepsBuilder in memory: no container and no install. It is given bundles'
 * manifests and files (`hold`, or `candidate` for one made from files), and a build is
 * a count and a pointer: one pointer for a namespace's install digest, at the
 * key the deps box's object keeps it at, answered again while it serves the
 * need. Each build's one part is named after the count, so a test can tell
 * one build from another. A digest told to fail (`failBuilds`) answers
 * `DepsUnavailable` with the reason, and so does a build from a bundle that
 * is not held.
 */
export function makeDepsBuilderMemory(): DepsBuilderHarness & {
  /** Every build that ran, in order: a pointer that served ran none. */
  readonly built: readonly DepsBuilt[];
  /** Every call to `need` and to `build`, in order, whatever it answered. */
  readonly asked: readonly string[];
  /** The pointers kept, by their key. */
  readonly pointers: ReadonlyMap<string, DepsPointer>;
  /** Keeps `manifest` as the manifest of the namespace's bundle `bundle`, and `files` (path to text) as what it holds. */
  readonly hold: (
    namespace: NamespaceId,
    bundle: ContentHash,
    manifest: string,
    files?: Readonly<Record<string, string>>,
  ) => void;
} {
  const manifests = new Map<string, string>();
  const texts = new Map<string, Readonly<Record<string, string>>>();
  const pointers = new Map<string, DepsPointer>();
  const failing = new Map<string, string>();
  const built: DepsBuilt[] = [];
  const asked: string[] = [];
  const hold = (
    namespace: NamespaceId,
    bundle: ContentHash,
    manifest: string,
    files: Readonly<Record<string, string>> = {},
  ) => {
    manifests.set(bundleKeyOf(namespace, bundle), manifest);
    texts.set(bundleKeyOf(namespace, bundle), files);
  };
  const build = (namespace: NamespaceId, need: Locked, bundle: ContentHash): DepsAnswer => {
    asked.push(`build ${need.install}`);
    const key = namespaceKey(namespace, "deps", need.install);
    const kept = pointers.get(key);
    if (kept !== undefined && pointerServes(kept, need))
      return { _tag: "DepsReady", install: kept.install, parts: kept.parts };
    const reason = failing.get(need.install);
    if (reason !== undefined) return { _tag: "DepsUnavailable", reason };
    if (!manifests.has(bundleKeyOf(namespace, bundle)))
      return { _tag: "DepsUnavailable", reason: "bundle-unfetched" };
    built.push({ namespace, need, bundle });
    const pointer: DepsPointer = {
      format: "keel.deps/1",
      install: need.install,
      toolchain: DEPS_TOOLCHAIN,
      parts: [{ sha256: built.length.toString(16).padStart(64, "0"), bytes: 1024 }],
      files: 1,
      installMs: 0,
    };
    pointers.set(key, pointer);
    return { _tag: "DepsReady", install: pointer.install, parts: pointer.parts };
  };
  return {
    built,
    asked,
    pointers,
    hold,
    candidate: (namespace, files) =>
      Effect.promise(async () => {
        const encoder = new TextEncoder();
        const lines = await Promise.all(
          Object.entries(files)
            .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(async ([path, text]) => `${await hexOf(encoder.encode(text))}  ${path}\n`),
        );
        const manifest = lines.join("");
        const bundle = Schema.decodeUnknownSync(ContentHash)(
          `sha256:${await hexOf(encoder.encode(manifest))}`,
        );
        hold(namespace, bundle, manifest, files);
        return bundle;
      }),
    failBuilds: (install, reason) => Effect.sync(() => void failing.set(install, reason)),
    builds: (namespace, install) =>
      Effect.sync(
        () => built.filter((b) => b.namespace === namespace && b.need.install === install).length,
      ),
    layer: Layer.succeed(
      DepsBuilder,
      DepsBuilder.of({
        need: (namespace, bundle) =>
          Effect.suspend(() => {
            asked.push(`need ${bundle}`);
            const manifest = manifests.get(bundleKeyOf(namespace, bundle));
            return manifest === undefined
              ? Effect.fail(new BundleMissing({ hash: bundle }))
              : depsNeedFrom(
                  manifest,
                  (path) => {
                    const files = texts.get(bundleKeyOf(namespace, bundle)) ?? {};
                    return Object.hasOwn(files, path) ? files[path] : undefined;
                  },
                  (text) => Effect.promise(() => hexOf(new TextEncoder().encode(text))),
                );
          }),
        build: (namespace, need, bundle) => Effect.sync(() => build(namespace, need, bundle)),
      }),
    ),
  };
}
