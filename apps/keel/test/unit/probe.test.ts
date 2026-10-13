// The Probe program end to end over memory adapters: core's probeConflict,
// one durable step at a time, as the Workflow runs it. The ledger runs the
// domain's real conflict and probe machines, sources and hunks come from the
// real ProbeSourcesCodeHost over the in-memory host, and the steps keep
// every value as the Workflow does, so a replay is checked too.
import { describe, expect, it } from "@effect/vitest";
import { projectRepos } from "@keeltown/core/application/integration";
import {
  abRef,
  type FreshnessSlots,
  partyEventType,
  type ProbeEnd,
  type ProbeRun,
  type ProbeSteps,
  probeConflict,
  probeSubscriber,
} from "@keeltown/core/application/verification";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { ConflictCommand, ProbeOutcome, World } from "@keeltown/core/domain/verification";
import {
  type ChangeId,
  CommitSha,
  ContentHash,
  type EntityRef,
  makeId,
} from "@keeltown/core/kernel";
import {
  AdmittedGuards,
  CandidateComposer,
  type CandidateRequest,
  CodeHost,
  NoopWorlds,
  PlatformFunction,
  ProbeLedger,
  ProbeRunner,
  ProbeStore,
  type RepoRef,
} from "@keeltown/core/ports";
import {
  type FixtureFiles,
  makeAdmittedGuardsMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeEvidenceStoreMemory,
  makeIdsMemory,
  makeManualClock,
  makePlanStoreMemory,
  makeProbeChangesMemory,
  makeProbeLedgerMemory,
  makeTrunksMemory,
  makeWorldChecksMemory,
  sampleNamespace,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { FlowSpecSourceCodeHost } from "../../src/adapters/driven/gitcore/flow-spec-source.ts";
import { ProbeSourcesCodeHost } from "../../src/adapters/driven/gitcore/probe-sources.ts";
import { memorySteps } from "./memory-steps.ts";

const MAIN = "refs/heads/main";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);

/** A's revoke, as S-1's a.patch adds it: what the slots name for A-noop. */
const REVOKE_PATH = "src/routes/collaborators.ts";
const REVOKE_CALL = "store.removeCollaborator(repo.id, target.id, actor.id, clock.now());";
const BASE: FixtureFiles = {
  "src/app.ts": "export const createApp = () => {};\n",
  [REVOKE_PATH]: "const existing = 1;\n",
};
const A_TREE: FixtureFiles = {
  ...BASE,
  [REVOKE_PATH]: `const existing = 1;\napp.delete("/repos/:owner/:repo/collaborators/:username", async (c) => {\n  ${REVOKE_CALL}\n});\n`,
};
const B_TREE: FixtureFiles = { ...BASE, "src/cache.ts": "export const cache = new Map();\n" };

/** S-1's slots, as scenarios/s1/probe.test.ts makes its calls. */
const SLOTS: FreshnessSlots = {
  owner: "alice",
  subject: "bob",
  setup: [
    {
      actor: "owner",
      method: "POST",
      path: "/repos",
      body: '{"name":"forge","visibility":"public"}',
      expectedStatus: 201,
    },
    {
      actor: "owner",
      method: "PUT",
      path: "/repos/alice/forge/collaborators/bob",
      body: '{"role":"admin"}',
      expectedStatus: 201,
    },
  ],
  call: {
    actor: "subject",
    method: "GET",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 200,
  },
  revoke: {
    actor: "owner",
    method: "DELETE",
    path: "/repos/alice/forge/collaborators/bob",
    body: "",
    expectedStatus: 204,
  },
  callAgain: {
    actor: "subject",
    method: "DELETE",
    path: "/repos/alice/forge",
    body: "",
    expectedStatus: 403,
  },
  noop: { path: REVOKE_PATH, call: REVOKE_CALL },
  rationale: "revoked mid-session",
};

/** A probe that tests the premise: passes on trunk and in A, fails combined and against A-noop. */
const DISCRIMINATING: Readonly<Record<World, ProbeOutcome>> = {
  trunk: "pass",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};
/** A probe that never tested the premise: it fails in every world alike. */
const IDENTICAL: Readonly<Record<World, ProbeOutcome>> = {
  trunk: "fail",
  A: "fail",
  B: "fail",
  AB: "fail",
  "A-noop": "fail",
};
const ran = (outcome: ProbeOutcome): ProbeRun => ({
  _tag: "ran",
  outcome,
  reason: outcome,
  observations: [],
});

/** The A-noop world the probe's NoopWorlds double answers. */
const A_NOOP = hash(99);

interface Options {
  /** Each world's outcome: the probe's matrix. */
  readonly matrix?: Readonly<Record<World, ProbeOutcome>>;
  /** Whether the conflict names the effect against the premise. */
  readonly effect?: boolean;
  /** AB cannot be composed. */
  readonly refuseCompose?: boolean;
}

/**
 * One project's S-1 conflict: A (the premise holder) adds the revoke, B adds
 * a session cache, both on trunk's head T in their own workspaces. Nothing
 * is submitted until a case says so.
 */
function probeWorld(options: Options = {}) {
  const host = makeCodeHostMemory();
  const projectId = makeId("prj", ulid());
  const staging = projectRepos(projectId).staging;
  const wsA: RepoRef = { namespace: "keel-ws-00", name: `ws-a-${ulid().toLowerCase()}` };
  const wsB: RepoRef = { namespace: "keel-ws-00", name: `ws-b-${ulid().toLowerCase()}` };
  const key = Schema.decodeUnknownSync(SubjectKey)("authz.permission-evaluation");
  const at = { projectId, key };
  const conflictId = makeId("cfl", ulid());
  const instanceId = `probe-${conflictId}`;
  const [A, B] = [makeId("chg", ulid()), makeId("chg", ulid())];
  const told: { readonly subscriber: string; readonly changeId: ChangeId }[] = [];
  const changes = makeProbeChangesMemory((subscriber, changeId) => {
    told.push({ subscriber, changeId });
  });
  const ledger = makeProbeLedgerMemory();
  const trunks = makeTrunksMemory();
  const guards = makeAdmittedGuardsMemory();
  const clock = makeManualClock();
  const composed: CandidateRequest[] = [];
  const noops: ContentHash[] = [];
  /** The namespace each store call and probe run named, by what was called. */
  const named: { readonly call: string; readonly namespace: string }[] = [];
  const evidence = makeEvidenceStoreMemory();
  const runs: { readonly world: World; readonly bundle: ContentHash }[] = [];
  const bundles = makeCandidateBundlesMemory();
  const worldChecks = makeWorldChecksMemory();
  const plans = makePlanStoreMemory();
  const memoryComposer = makeCandidateComposerMemory({
    refuse: options.refuseCompose === true ? [A, B] : [],
  });
  const matrix = options.matrix ?? DISCRIMINATING;
  const layer = Layer.mergeAll(
    host.layer,
    ledger.layer,
    changes.layer,
    trunks.layer,
    guards.layer,
    clock.layer,
    makeIdsMemory().layer,
    evidence.layer,
    bundles.layer,
    ProbeSourcesCodeHost.pipe(Layer.provide(host.layer)),
    FlowSpecSourceCodeHost.pipe(Layer.provide(host.layer)),
    plans.layer,
    worldChecks.layer,
    Layer.effect(
      CandidateComposer,
      Effect.gen(function* () {
        const inner = yield* CandidateComposer;
        return CandidateComposer.of({
          compose: (request) =>
            Effect.suspend(() => {
              composed.push(request);
              return inner.compose(request);
            }),
        });
      }),
    ).pipe(Layer.provide(memoryComposer.layer)),
    Layer.succeed(
      NoopWorlds,
      NoopWorlds.of({
        build: (namespace, world) =>
          Effect.sync(() => {
            noops.push(world);
            named.push({ call: "noop", namespace });
            return A_NOOP;
          }),
      }),
    ),
    Layer.succeed(PlatformFunction, PlatformFunction.of({ call: () => Effect.succeed(SLOTS) })),
    Layer.succeed(
      ProbeStore,
      ProbeStore.of({
        put: (namespace) =>
          Effect.sync(() => {
            named.push({ call: "probe", namespace });
            return hash(7);
          }),
        get: () => Effect.die("the Probe never reads a probe's source back"),
      }),
    ),
    Layer.succeed(
      ProbeRunner,
      ProbeRunner.of({
        run: (request) =>
          Effect.sync(() => {
            runs.push({ world: request.world, bundle: request.worldBundle });
            named.push({ call: "run", namespace: request.namespace });
            return ran(matrix[request.world]);
          }),
      }),
    ),
  );
  const suspect: Extract<ConflictCommand, { _tag: "Suspect" }> = {
    _tag: "Suspect",
    kind: "semantic",
    parties: [A, B],
    subjectId: makeId("sub", ulid()),
    predicate: "freshness",
    origin: "fallout",
    premise: {
      holder: A,
      proposition: {
        subject: key,
        predicate: "freshness",
        relation: "at-most",
        value: "per-request",
      },
    },
    ...(options.effect === false
      ? {}
      : {
          effect: {
            changeId: B,
            proposition: {
              subject: key,
              predicate: "freshness",
              relation: "is",
              value: "per-session",
            },
          },
        }),
  };
  /** Trunk's head T in staging, each workspace forked at T with its change on top, and the conflict suspected. */
  const setup = Effect.gen(function* () {
    const code = yield* CodeHost;
    for (const repo of [staging, wsA, wsB]) yield* code.create(repo);
    const T = yield* host.fixture.commit(staging, MAIN, BASE);
    yield* host.fixture.commit(wsA, MAIN, BASE);
    yield* host.fixture.commit(wsB, MAIN, BASE);
    const headA = yield* host.fixture.commit(wsA, MAIN, A_TREE);
    const headB = yield* host.fixture.commit(wsB, MAIN, B_TREE);
    trunks.heads.set(projectId, T);
    yield* ledger.suspect(at, conflictId, suspect);
    yield* changes.declare(A);
    yield* changes.declare(B);
    return { T, headA, headB };
  }).pipe(Effect.provide(host.layer), Effect.orDie);
  const call = { namespace: sampleNamespace, projectId, key, conflictId, instanceId, staging };
  return {
    host,
    projectId,
    staging,
    wsA,
    wsB,
    at,
    conflictId,
    instanceId,
    A,
    B,
    told,
    changes,
    ledger,
    trunks,
    guards,
    clock,
    composed,
    noops,
    runs,
    named,
    bundledFor: bundles.namespaces,
    evidenceKeys: () => [...evidence.documents.keys()],
    planKeys: () => [...plans.plans.keys()],
    bundled: bundles.bundled,
    worldChecks: worldChecks.started,
    layer,
    setup,
    /** Submits each party from its own workspace, on T. */
    submitBoth: (heads: {
      readonly T: CommitSha;
      readonly headA: CommitSha;
      readonly headB: CommitSha;
    }) =>
      Effect.all([
        changes.submit(A, { repo: wsA, head: heads.headA, base: heads.T }),
        changes.submit(B, { repo: wsB, head: heads.headB, base: heads.T }),
      ]),
    run: (steps: ProbeSteps) => probeConflict(call, steps).pipe(Effect.provide(layer)),
    log: (entity: EntityRef) => ledger.log(at, entity),
    /** The conflict and its probe, as the ledger holds them. */
    view: () =>
      Effect.gen(function* () {
        return yield* (yield* ProbeLedger).conflict(at, conflictId);
      }).pipe(Effect.provide(layer), Effect.orDie),
  };
}

const types = (log: readonly { readonly type: string }[]) => log.map((e) => e.type);
const conflictRef = (conflictId: string): EntityRef => ({ kind: "conflict", id: conflictId });

describe("probeConflict", () => {
  it.effect(
    "[probe.admits] drafts the conflict's probe in its five worlds, reports every cell, and commits the guard once the ledger admits it",
    () => {
      const w = probeWorld();
      const s = memorySteps();
      return Effect.gen(function* () {
        const heads = yield* w.setup;
        yield* w.submitBoth(heads);
        const end = yield* w.run(s.steps());
        expect(end).toMatchObject({ outcome: "admitted" });
        if (end.outcome !== "admitted") return;
        // AB is A and B composed onto trunk's head, pushed to the probe's own ref, never a cand/ ref.
        expect(w.composed).toHaveLength(1);
        expect(w.composed[0]).toMatchObject({
          staging: w.staging,
          base: heads.T,
          ref: abRef(w.conflictId),
          members: [
            { changeId: w.A, repo: w.wsA, base: heads.T, head: heads.headA },
            { changeId: w.B, repo: w.wsB, base: heads.T, head: heads.headB },
          ],
        });
        // Trunk is bundled from staging, each party from its workspace, AB from staging; A-noop from A's bundle.
        expect(w.bundled).toHaveLength(4);
        expect(w.bundled.slice(0, 3)).toEqual([heads.T, heads.headA, heads.headB]);
        expect(w.noops).toHaveLength(1);
        expect(new Set(w.runs.filter((r) => r.world === "A-noop").map((r) => r.bundle))).toEqual(
          new Set([A_NOOP]),
        );
        // [t5.probe.namespace] Everything the Probe keeps or runs names the namespace its call carries:
        // the four world bundles, A-noop, the probe, all fifteen runs, each cell's evidence and trunk's plan.
        const NAMESPACE = "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
        expect(w.bundledFor).toEqual([NAMESPACE, NAMESPACE, NAMESPACE, NAMESPACE]);
        expect(w.named.filter((n) => n.call === "run")).toHaveLength(15);
        expect(w.named.map((n) => n.call)).toContain("noop");
        expect(w.named.map((n) => n.call)).toContain("probe");
        expect(new Set(w.named.map((n) => n.namespace))).toEqual(new Set([NAMESPACE]));
        expect(w.evidenceKeys()).toHaveLength(15);
        expect(w.evidenceKeys().every((k) => k.startsWith(`ns/${NAMESPACE}/evidence/`))).toBe(true);
        expect(w.planKeys()).toHaveLength(1);
        expect(w.planKeys().every((k) => k.startsWith(`ns/${NAMESPACE}/plans/`))).toBe(true);
        expect([...w.worldChecks.values()].map((job) => job.namespace)).toEqual([
          NAMESPACE,
          NAMESPACE,
          NAMESPACE,
          NAMESPACE,
        ]);
        // B's cells are recorded before the cells that decide.
        const ranCells = s.ran.filter((n) => n.startsWith("cell "));
        expect(ranCells).toHaveLength(15);
        expect(ranCells.slice(0, 3)).toEqual(["cell B@1", "cell B@2", "cell B@3"]);
        const listed = yield* Effect.provide(
          Effect.gen(function* () {
            return yield* (yield* AdmittedGuards).list(w.projectId);
          }),
          w.layer,
        );
        expect(listed.admitted).toEqual([
          {
            guardId: end.guardId,
            probe: hash(7),
            tenet: {
              proposition: {
                subject: w.at.key,
                predicate: "freshness",
                relation: "at-most",
                value: "per-request",
              },
            },
          },
        ]);
        const probeLog = yield* w.log({ kind: "probe", id: end.probeId });
        expect(types(probeLog)).toContain("GuardAdmitted");
        expect(types(probeLog).filter((t) => t === "ProbeRan")).toHaveLength(15);
        // One world check per world, started once the probe was drafted: each party's suite names
        // its change, whose plan the check reads when it runs (no Precheck has compiled one here),
        // both in AB, and trunk's from trunk's own flow.
        const started = [...w.worldChecks.entries()];
        expect(started.map(([id]) => id)).toEqual(
          ["trunk", "A", "B", "AB"].map((world) => `world-${w.conflictId}-${world}`),
        );
        const checksOf = (world: string) =>
          started.find(([, job]) => job.world === world)?.[1].checks;
        expect(checksOf("A")).toEqual([
          { check: `suite:${w.A}`, plan: { _tag: "OfChange", changeId: w.A } },
        ]);
        expect(checksOf("B")).toEqual([
          { check: `suite:${w.B}`, plan: { _tag: "OfChange", changeId: w.B } },
        ]);
        expect(checksOf("AB")).toEqual([
          { check: `suite:${w.A}`, plan: { _tag: "OfChange", changeId: w.A } },
          { check: `suite:${w.B}`, plan: { _tag: "OfChange", changeId: w.B } },
        ]);
        expect(checksOf("trunk")).toEqual([
          { check: "suite:trunk", plan: { _tag: "Planned", planHash: expect.any(String) } },
        ]);
        expect(new Set(started.map(([, job]) => job.bundle)).size).toBe(4);
        // The cells never wait for the world checks: they are evidence for people, not admission.
        expect(s.ran.indexOf("world checks")).toBeLessThan(s.ran.indexOf("cell B@1"));
      });
    },
  );

  it.effect(
    "[probe.replay] a replay answers every step from what it kept and reports nothing again",
    () => {
      const w = probeWorld();
      const s = memorySteps();
      return Effect.gen(function* () {
        yield* w.submitBoth(yield* w.setup);
        const first = yield* w.run(s.steps());
        const steps = s.ran.length;
        const before = yield* w.log(conflictRef(w.conflictId));
        expect(yield* w.run(s.steps())).toEqual(first);
        expect(s.ran).toHaveLength(steps);
        expect(yield* w.log(conflictRef(w.conflictId))).toEqual(before);
        expect(w.composed).toHaveLength(1);
      });
    },
  );

  it.effect(
    "[probe.waits] a party with nothing submitted is waited for, as this instance's subscriber, and drafted once it submits",
    () => {
      const w = probeWorld();
      let heads: { readonly T: CommitSha; readonly headA: CommitSha; readonly headB: CommitSha };
      const s = memorySteps({
        onWait: (type) =>
          type === partyEventType(w.A)
            ? Effect.as(
                w.changes.submit(w.A, { repo: w.wsA, head: heads.headA, base: heads.T }),
                true,
              )
            : Effect.succeed(false),
      });
      return Effect.gen(function* () {
        heads = yield* w.setup;
        yield* w.changes.submit(w.B, { repo: w.wsB, head: heads.headB, base: heads.T });
        const end = yield* w.run(s.steps());
        expect(end.outcome).toBe("admitted");
        expect(s.waits.map((x) => x.type)).toEqual([partyEventType(w.A)]);
        expect(w.told).toEqual([{ subscriber: probeSubscriber(w.instanceId), changeId: w.A }]);
      });
    },
  );

  it.effect(
    "[probe.deadline] a party that never submits within the wait ends the draft as no-submission, and the wait is never longer than what is left",
    () => {
      const w = probeWorld();
      const s = memorySteps({
        onWait: (_, timeoutMs) =>
          Effect.sync(() => {
            w.clock.advance(timeoutMs);
            return false;
          }),
        // A minute passes between the instance starting and its first wait.
        after: { started: Effect.sync(() => w.clock.advance(60_000)) },
      });
      return Effect.gen(function* () {
        const heads = yield* w.setup;
        yield* w.changes.submit(w.B, { repo: w.wsB, head: heads.headB, base: heads.T });
        const end = yield* w.run(s.steps());
        expect(end).toEqual({ outcome: "draft-failed", reason: "no-submission", attempts: 0 });
        expect(s.waits).toHaveLength(1);
        expect(s.waits[0]?.timeoutMs).toBe(24 * 60 * 60 * 1000 - 60_000);
        expect(yield* w.view()).toMatchObject({
          probe: { state: "discarded", discarded: "draft-failed" },
        });
      });
    },
  );

  it.effect(
    "[probe.landed] a party that landed is its commit on trunk over its first parent, and AB composes the other onto it",
    () => {
      const w = probeWorld();
      const s = memorySteps();
      return Effect.gen(function* () {
        const heads = yield* w.setup;
        // A landed as L on staging's main, over P = T.
        const L = yield* w.host.fixture.commit(w.staging, MAIN, A_TREE).pipe(Effect.orDie);
        w.trunks.heads.set(w.projectId, L);
        yield* w.changes.land(w.A, L, heads.T);
        yield* w.changes.submit(w.B, { repo: w.wsB, head: heads.headB, base: heads.T });
        const end = yield* w.run(s.steps());
        expect(end.outcome).toBe("admitted");
        expect(w.bundled.slice(0, 3)).toEqual([heads.T, L, heads.headB]);
        expect(w.composed[0]).toMatchObject({
          base: L,
          members: [{ changeId: w.B, repo: w.wsB, base: heads.T, head: heads.headB }],
        });
      });
    },
  );

  it.effect(
    "[probe.workspace-gone] a workspace that goes with its landing under the read is read again as landed, never as a harness error",
    () => {
      const w = probeWorld();
      let heads: { readonly T: CommitSha; readonly headA: CommitSha; readonly headB: CommitSha };
      const s = memorySteps({
        after: {
          // A lands between the parties' reads and the worlds': landing collects its workspace.
          "party B 1": Effect.gen(function* () {
            const L = yield* w.host.fixture.commit(w.staging, MAIN, A_TREE).pipe(Effect.orDie);
            w.trunks.heads.set(w.projectId, L);
            yield* w.changes.land(w.A, L, heads.T);
            yield* Effect.provide(
              Effect.gen(function* () {
                yield* (yield* CodeHost).delete(w.wsA);
              }),
              w.host.layer,
            );
          }),
        },
      });
      return Effect.gen(function* () {
        heads = yield* w.setup;
        yield* w.submitBoth(heads);
        const end = yield* w.run(s.steps());
        expect(end.outcome).toBe("admitted");
        expect(s.ran).toContain("worlds#2");
        expect(w.composed.at(-1)).toMatchObject({ members: [{ changeId: w.B }] });
      });
    },
  );

  it.effect(
    "[probe.unreadable] a world's commit missing from staging is a harness error naming it, and no fact is reported",
    () => {
      const w = probeWorld();
      const s = memorySteps();
      const missing = CommitSha.make("f".repeat(40));
      return Effect.gen(function* () {
        yield* w.submitBoth(yield* w.setup);
        w.trunks.heads.set(w.projectId, missing);
        const end = yield* w.run(s.steps());
        expect(end).toEqual({
          outcome: "unreadable",
          world: "trunk",
          repo: `${w.staging.namespace}/${w.staging.name}`,
          commit: missing,
          reason: "ObjectNotFound",
        } satisfies ProbeEnd);
        expect(types(yield* w.log(conflictRef(w.conflictId)))).toEqual(["ConflictSuspected"]);
        expect(w.runs).toHaveLength(0);
      });
    },
  );

  it.effect(
    "[probe.no-propositions] a conflict that names no effect fails its draft unprovable, without waiting for anyone",
    () => {
      const w = probeWorld({ effect: false });
      const s = memorySteps();
      return Effect.gen(function* () {
        yield* w.setup;
        const end = yield* w.run(s.steps());
        expect(end).toEqual({ outcome: "draft-failed", reason: "no-propositions", attempts: 0 });
        expect(s.waits).toEqual([]);
        expect(s.ran).toEqual(["conflict", "draft-failed"]);
      });
    },
  );

  it.effect(
    "[probe.party-gone] a party withdrawn while the conflict is still suspected fails the draft party-gone",
    () => {
      const w = probeWorld();
      const s = memorySteps();
      return Effect.gen(function* () {
        const heads = yield* w.setup;
        yield* w.changes.submit(w.B, { repo: w.wsB, head: heads.headB, base: heads.T });
        yield* w.changes.leave(w.A, "withdrawn");
        const end = yield* w.run(s.steps());
        expect(end).toEqual({ outcome: "draft-failed", reason: "party-gone", attempts: 0 });
        expect(s.ran).toContain("conflict A gone");
      });
    },
  );

  it.effect(
    "[probe.worlds-unbuildable] A and B that do not compose leave the conflict unprobed: no draft, no cell",
    () => {
      const w = probeWorld({ refuseCompose: true });
      const s = memorySteps();
      return Effect.gen(function* () {
        yield* w.submitBoth(yield* w.setup);
        const end = yield* w.run(s.steps());
        expect(end).toEqual({ outcome: "draft-failed", reason: "worlds-unbuildable", attempts: 0 });
        expect(w.runs).toHaveLength(0);
        expect(s.ran).not.toContain("draft");
      });
    },
  );

  it.effect(
    "[probe.repairs-exhausted] a probe that fails alike in every world is repaired, then fails its draft once the repairs run out",
    () => {
      const w = probeWorld({ matrix: IDENTICAL });
      const s = memorySteps();
      return Effect.gen(function* () {
        yield* w.submitBoth(yield* w.setup);
        const end = yield* w.run(s.steps());
        expect(end).toEqual({ outcome: "draft-failed", reason: "repairs-exhausted", attempts: 4 });
        expect(s.ran).not.toContain("drafted");
      });
    },
  );

  it.effect(
    "[probe.discarded] a probe that ran clean but passes in A-noop is drafted with its cells, the domain discards it, and no guard is committed",
    () => {
      const w = probeWorld({ matrix: { ...DISCRIMINATING, "A-noop": "pass" } });
      const s = memorySteps();
      return Effect.gen(function* () {
        yield* w.submitBoth(yield* w.setup);
        const end = yield* w.run(s.steps());
        expect(end).toMatchObject({ outcome: "drafted", state: "discarded" });
        if (end.outcome !== "drafted") return;
        expect(s.ran).toContain("drafted");
        expect(s.ran).not.toContain("guard");
        const probeLog = yield* w.log({ kind: "probe", id: end.probeId });
        expect(types(probeLog)).toContain("ProbeDiscarded");
        expect(types(probeLog)).not.toContain("GuardAdmitted");
      });
    },
  );

  it.effect("[probe.moved-on] a conflict no longer suspected is left alone: no fact at all", () => {
    const w = probeWorld();
    const s = memorySteps();
    return Effect.gen(function* () {
      yield* w.submitBoth(yield* w.setup);
      yield* w.run(memorySteps().steps());
      const after = yield* w.log(conflictRef(w.conflictId));
      const end = yield* w.run(s.steps());
      expect(end).toMatchObject({ outcome: "moved-on" });
      expect(yield* w.log(conflictRef(w.conflictId))).toEqual(after);
    });
  });
});
