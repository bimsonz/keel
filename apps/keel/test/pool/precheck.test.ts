import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { subjectAddress } from "@keeltown/core/application/coordination";
import {
  DERIVATION_KIND,
  DerivationRecord,
  deriveSubmission,
  diffSubmission,
  readStoredPlan,
} from "@keeltown/core/application/verification";
import { DerivedEffect, Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import type { AdmittedGuard } from "@keeltown/core/domain/verification";
import { CommitSha, ContentHash, type Json, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost, EvidenceStore, type PrecheckWorkspace } from "@keeltown/core/ports";
import { CodeHostFixture, TEST_GUARD } from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { ProjectsRpc } from "../../src/adapters/driven/do-rpc/projects.ts";
import { EvidenceStoreR2 } from "../../src/adapters/driven/r2/evidence-store.ts";
import { planKey } from "../../src/adapters/driven/r2/plan-store.ts";
import { SyntaxSourceTreeSitter } from "../../src/adapters/driven/syntax/syntax-source.ts";
import { SYNTAX_WASM } from "../../src/adapters/driven/syntax/wasm.ts";
import { PrecheckParams } from "../../src/adapters/driving/workflow/precheck.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { drainAfter, drainOutbox, POOL_ORG } from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";

const WAIT = { timeout: 15_000, interval: 50 };
const GUARDS = [".keel/guards/**"];
const BASE = "b".repeat(40);

/** What the ancestry step answers: the submitted commit descends from `base`. */
const descends = (base: string) => ({ _tag: "Done", value: { _tag: "Descends", base } });

/** What the diff step answers: these paths touched. */
const touched = (paths: readonly string[]) => ({
  _tag: "Done",
  value: { _tag: "Touched", paths },
});
/** What the policy step answers: these protected globs, and core's guard paths. */
const policy = (protectedPaths: readonly string[]) => ({
  _tag: "Done",
  value: { protectedPaths, guardPaths: GUARDS },
});
/** What the flow step answers: the base's root holds only `.keel/flow.json`, when given. */
const flow = (flowJson?: string) => ({
  _tag: "Done",
  value: {
    _tag: "Read",
    sources: flowJson === undefined ? { rootPaths: [] } : { rootPaths: [".keel"], flowJson },
  },
});
/** What the guards step answers: these guards admitted, none refused. */
const guards = (admitted: readonly AdmittedGuard[] = []) => ({
  _tag: "Done",
  value: { _tag: "Listed", admitted, refused: [] },
});

const key = Schema.decodeUnknownSync(SubjectKey);
/** TEST_GUARD's tenet, on `authz.sessions`, as a premise the change relies on. */
const SESSIONS = Schema.decodeUnknownSync(Proposition)(TEST_GUARD.tenet.proposition);
/** What derivation rules the pushed commit does to `authz.sessions`: within TEST_GUARD's tenet, so nothing conflicts. */
const derivedAtSessions = (commitSha: string) => {
  const anchors = [{ path: "src/sessions.ts", symbol: "sessionOf", commit: commitSha }];
  return Schema.decodeUnknownSync(DerivedEffect)({
    proposition: { ...SESSIONS, relation: "is", anchors },
    anchors,
    declared: false,
    method: "extractor",
    evidenceClass: "ruling",
  });
};

/** An admitted guard on a subject the change neither relies on nor affects. */
const INVOICES: AdmittedGuard = {
  guardId: makeId("grd", ulid()),
  probe: Schema.decodeUnknownSync(ContentHash)(`sha256:${"8".repeat(64)}`),
  tenet: { proposition: { ...SESSIONS, subject: key("billing.invoice") } },
};

/**
 * A change declared and pushed on a Change DO under test. `submit` submits
 * it, and the outbox then starts its Precheck: a test that mocks a step with
 * something of the change's own mocks it before it submits.
 */
async function pushed(premises: readonly Proposition[] = [], on?: ChangeUnderTest) {
  const c = on ?? (await changeUnderTest());
  const lease = ok(await c.declare("declare-1", { premises })).change.lease.id;
  const commitSha = await c.push();
  const submit = async () =>
    void ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          leaseId: lease,
          commitSha,
          idempotencyKey: "s-1",
        }),
      ),
    );
  return { c, commitSha, submit };
}

/** A change declared, pushed and submitted on a Change DO under test; the outbox starts its Precheck. */
async function submitted(premises: readonly Proposition[] = []) {
  const { c, commitSha, submit } = await pushed(premises);
  await submit();
  return { c, commitSha };
}

/**
 * What the derive step answers for the change's pushed commit, with the
 * record it names kept in ARCHIVE as the step keeps it: a derivation that
 * read both commits whole and found these effects.
 */
async function kept(c: ChangeUnderTest, commitSha: string, effects: readonly DerivedEffect[] = []) {
  const { repo } = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));
  const read = { parser: "mocked", skipped: [] };
  const record: Json = JSON.parse(
    JSON.stringify(
      Schema.encodeSync(DerivationRecord)({
        kind: DERIVATION_KIND,
        changeId: c.changeId,
        revision: 1,
        repo,
        base: CommitSha.make(BASE),
        head: CommitSha.make(commitSha),
        seeds: ["src/a.ts"],
        anchors: [],
        readings: { base: read, head: read },
        effects,
        undecided: [],
      }),
    ),
  );
  const derivationRef = await Effect.runPromise(
    EvidenceStore.use((store) => store.put(POOL_ORG, record)).pipe(
      Effect.provide(EvidenceStoreR2(env.ARCHIVE)),
    ),
  );
  return {
    _tag: "Done",
    value: { derivationRef, subjects: effects.map((effect) => effect.proposition.subject) },
  };
}

const SESSIONS_FILE = "src/authz/sessions.ts";
/** The module at the base: `sessionOf` reads the session on every call, and nothing holds one. */
const UNCACHED = `
export interface Session {
  readonly id: string;
  readonly revoked: boolean;
}

function readSession(sessionId: string): Session {
  return { id: sessionId, revoked: false };
}

export function sessionOf(sessionId: string): Session {
  return readSession(sessionId);
}
`;
/** The module at the head: `sessionOf` now reads through a Map the module holds, keyed by the session's id. */
const CACHED = `
export interface Session {
  readonly id: string;
  readonly revoked: boolean;
}

const cache = new Map<string, Session>();

function readSession(sessionId: string): Session {
  return { id: sessionId, revoked: false };
}

export function sessionOf(sessionId: string): Session {
  const held = cache.get(sessionId);
  if (held !== undefined) return held;
  const session = readSession(sessionId);
  cache.set(sessionId, session);
  return session;
}
`;
/** Where a neighbour anchors `authz.sessions`: the function that reads a session, pinned at a commit of neither push. */
const SESSION_OF = { path: SESSIONS_FILE, symbol: "sessionOf", commit: "a".repeat(40) };
/** What the neighbour relies on there: a session no staler than per-session, which the head's cache keeps. */
const RELIED = Schema.decodeUnknownSync(Proposition)({
  ...SESSIONS,
  value: "per-session",
  anchors: [SESSION_OF],
});

/** loadgen's effect pair (run lg50a): `price` as the base holds it, and as the planted side rewrites it with a log. */
const PRICE_FILE = "bench/p2.ts";
const PRICED = (body: string) => `export function price(n: number): number {\n${body}\n}\n`;
const PURE_PRICE = PRICED("  return n * 2;");
const LOGGED_PRICE = PRICED('  console.info("priced", n);\n  return n * 2;');
/** What the other side relies on: `price` stays pure, anchored at it, pinned at a commit of neither push. */
const PRICE_IS_PURE = Schema.decodeUnknownSync(Proposition)({
  subject: "bench.price",
  predicate: "purity",
  relation: "is",
  value: true,
  anchors: [{ path: PRICE_FILE, symbol: "price", commit: "a".repeat(40) }],
});

/** Pushes two commits to the change's workspace on its in-memory code host, as its agent would: `before`, then `after` on top of it. */
const pushedOver = (
  c: ChangeUnderTest,
  workspace: PrecheckWorkspace,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(workspace.repo);
      const fixture = yield* CodeHostFixture;
      const base = yield* fixture.commit(workspace.repo, "refs/heads/main", before);
      const head = yield* fixture.commit(workspace.repo, "refs/heads/main", after);
      return { base, head };
    }).pipe(Effect.provide(c.code.layer)),
  );

/**
 * Core's derive step itself, in workerd, on what Precheck's runtime composes
 * wherever the pool can serve it: the project's live anchors from its Project
 * DO over RPC, tree-sitter as the Worker's own Wasm, and the record kept in
 * ARCHIVE. Only the code host is not the Workflow's, which holds no git
 * content here: the parser reads the commits on the change's in-memory one.
 * The step reads the submission's change, revision and commit, never its
 * instance, which no test can name before the outbox starts it.
 */
const derivedFrom = (
  c: ChangeUnderTest,
  workspace: PrecheckWorkspace,
  base: CommitSha,
  commitSha: CommitSha,
  paths: readonly string[],
) =>
  Effect.runPromise(
    deriveSubmission(
      POOL_ORG,
      workspace,
      {
        changeId: c.changeId,
        revision: 1,
        commitSha,
        baseSha: workspace.baseSha,
        instanceId: "precheck-not-started",
      },
      base,
      paths,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProjectsRpc((projectId) =>
            env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)),
          ),
          SyntaxSourceTreeSitter(SYNTAX_WASM).pipe(Layer.provide(c.code.layer)),
          EvidenceStoreR2(env.ARCHIVE),
        ),
      ),
    ),
  );

/**
 * Precheck through env.PRECHECK, started by the Change DO's outbox on
 * ChangeSubmitted, against the real Change DO over RPC. The ancestry walk,
 * the diff, the base's flow and the derivation's parse read the workspace on
 * the code host, which the DO under test keeps in memory, and the guard repo
 * and the Project DO's settings() are mocked with them; start, with the
 * change's subjects, derived, which commits the record the mocked derive step
 * names from ARCHIVE, decide, and the refusal or the stored plan run for
 * real. Which commit each read takes is core's `precheckReads`, and what
 * derive reads and keeps is core's `deriveSubmission`, both proven in the
 * unit suite. One case runs `deriveSubmission` itself here, on tree-sitter,
 * the Project DO's live anchors and ARCHIVE, and gives the Workflow its
 * answer as the derive step's: the step taken by the Workflow on its own code
 * host is left to a live run.
 */
describe("Precheck", () => {
  it("[d12.pool.compiled] records the derivation and then the plan of a clean submission on the change", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const { c, commitSha, submit } = await pushed();
    const derive = await kept(c, commitSha);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy(["infra/**"]));
      await m.mockStepResult({ name: "flow" }, flow());
      await m.mockStepResult({ name: "guards" }, guards());
      await m.mockStepResult({ name: "derive" }, derive);
    });
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("queued");
    const log = await c.log();
    expect(log.map((e) => e.type).slice(-4)).toEqual([
      "PrecheckStarted",
      "EffectsDerived",
      "PlanCompiled",
      "ChangeQueued",
    ]);
    expect(log.find((e) => e.type === "EffectsDerived")?.payload).toMatchObject({
      revision: 1,
      effects: [],
      derivationRef: derive.value.derivationRef,
    });
  });

  it("[d21.pool.subjects] compiles the change's own subjects against the admitted guards, under the base's policy, and queues the plan it stored", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const { c, commitSha, submit } = await pushed([SESSIONS]);
    const derive = await kept(c, commitSha);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult(
        { name: "flow" },
        flow(JSON.stringify({ predicates: { freshness: "block" } })),
      );
      await m.mockStepResult({ name: "guards" }, guards([TEST_GUARD, INVOICES]));
      await m.mockStepResult({ name: "derive" }, derive);
    });
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    const log = await c.log();
    const compiled = log.find((e) => e.type === "PlanCompiled")?.payload;
    const queued = log.find((e) => e.type === "ChangeQueued")?.payload;
    const { planHash } = Schema.decodeUnknownSync(Schema.Struct({ planHash: ContentHash }))(
      compiled,
    );
    expect(queued).toMatchObject({ planHash });
    const text = await (await env.ARCHIVE.get(planKey(POOL_ORG, planHash)))?.text();
    const plan = Result.getOrThrow(readStoredPlan(planHash, text ?? ""));
    expect(plan.steps.flatMap((s) => (s.guards === undefined ? [] : [s.guards]))).toEqual([
      { predicate: "freshness", policy: "block", probe: TEST_GUARD.probe },
    ]);
  });

  it("[d21.pool.derived] commits the effects the derive step kept, and compiles the guard of a subject only the derivation names", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    // The change declares no premise and no effect: `authz.sessions` reaches the plan from its derivation alone.
    const { c, commitSha, submit } = await pushed();
    const effect = derivedAtSessions(commitSha);
    const derive = await kept(c, commitSha, [effect]);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult(
        { name: "flow" },
        flow(JSON.stringify({ predicates: { freshness: "block" } })),
      );
      await m.mockStepResult({ name: "guards" }, guards([TEST_GUARD, INVOICES]));
      await m.mockStepResult({ name: "derive" }, derive);
    });
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    const log = await c.log();
    expect(log.find((e) => e.type === "EffectsDerived")?.payload).toEqual({
      _tag: "EffectsDerived",
      changeId: c.changeId,
      revision: 1,
      effects: [Schema.encodeSync(DerivedEffect)(effect)],
      derivationRef: derive.value.derivationRef,
    });
    const { planHash } = Schema.decodeUnknownSync(Schema.Struct({ planHash: ContentHash }))(
      log.find((e) => e.type === "PlanCompiled")?.payload,
    );
    const text = await (await env.ARCHIVE.get(planKey(POOL_ORG, planHash)))?.text();
    const plan = Result.getOrThrow(readStoredPlan(planHash, text ?? ""));
    expect(plan.steps.flatMap((s) => (s.guards === undefined ? [] : [s.guards]))).toEqual([
      { predicate: "freshness", policy: "block", probe: TEST_GUARD.probe },
    ]);
  });

  it("[d21.pool.derive-real] core's derivation, run here on tree-sitter, the Project DO's live anchors and ARCHIVE, finds the session cache a head puts under a neighbour's anchored function, and Precheck commits that effect and compiles the subject's guard", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const projectId: ProjectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const neighbour = await changeUnderTest(projectId, "project");
    // The subject and its parent hear the neighbour's premise and this change's derivation, and commit what they make of each.
    const hearing = [key("authz.sessions"), key("authz")].map((subject) =>
      drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, subject)))),
    );
    // Another live change of the project relies on sessions, anchored at `sessionOf`; drained, so the project's index holds that anchor.
    ok(await neighbour.declare("declare-neighbour", { premises: [RELIED] }));
    await drainOutbox(neighbour.stub);

    // This change declares no premise and no effect, and pushes the module without its cache, then with it.
    const lease = ok(await c.declare("declare-1")).change.lease.id;
    const workspace = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));
    const { base, head } = await pushedOver(
      c,
      workspace,
      { [SESSIONS_FILE]: UNCACHED },
      { [SESSIONS_FILE]: CACHED },
    );
    // What the diff step is mocked with below is what the code host's own diff of the two commits answers.
    expect(
      await Effect.runPromise(
        diffSubmission(workspace, base, head).pipe(Effect.provide(c.code.layer)),
      ),
    ).toEqual({ _tag: "Touched", paths: ["src/authz/sessions.ts"] });

    const answer = await derivedFrom(c, workspace, base, head, [SESSIONS_FILE]);
    expect(answer.subjects).toEqual(["authz.sessions"]);
    // The control: the same anchors, parser and store over the base read as its own head, where nothing is cached.
    const unchanged = await derivedFrom(c, workspace, base, base, [SESSIONS_FILE]);
    expect(unchanged.subjects).toEqual([]);

    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(base));
      await m.mockStepResult({ name: "diff" }, touched([SESSIONS_FILE]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult(
        { name: "flow" },
        flow(JSON.stringify({ predicates: { freshness: "block" } })),
      );
      await m.mockStepResult({ name: "guards" }, guards([TEST_GUARD, INVOICES]));
      await m.mockStepResult({ name: "derive" }, { _tag: "Done", value: answer });
    });
    ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          leaseId: lease,
          commitSha: head,
          idempotencyKey: "s-1",
        }),
      ),
    );
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    // The cache and the anchored function that reads through it, at the head.
    const anchors = [
      { path: "src/authz/sessions.ts", symbol: "cache", commit: head },
      { path: "src/authz/sessions.ts", symbol: "sessionOf", commit: head },
    ];
    const effect = {
      proposition: {
        subject: "authz.sessions",
        predicate: "freshness",
        relation: "is",
        value: "per-session",
        anchors,
      },
      anchors,
      declared: false,
      method: "extractor",
      evidenceClass: "ruling",
    };
    expect((await c.current()).state).toBe("queued");
    const log = await c.log();
    expect(log.map((e) => e.type).slice(-4)).toEqual([
      "PrecheckStarted",
      "EffectsDerived",
      "PlanCompiled",
      "ChangeQueued",
    ]);
    expect(log.find((e) => e.type === "EffectsDerived")?.payload).toEqual({
      _tag: "EffectsDerived",
      changeId: c.changeId,
      revision: 1,
      effects: [effect],
      derivationRef: answer.derivationRef,
    });
    // The change named no subject: the plan holds the guard on `authz.sessions` through the derivation alone.
    const { planHash } = Schema.decodeUnknownSync(Schema.Struct({ planHash: ContentHash }))(
      log.find((e) => e.type === "PlanCompiled")?.payload,
    );
    const text = await (await env.ARCHIVE.get(planKey(POOL_ORG, planHash)))?.text();
    const plan = Result.getOrThrow(readStoredPlan(planHash, text ?? ""));
    expect(plan.steps.flatMap((s) => (s.guards === undefined ? [] : [s.guards]))).toEqual([
      { predicate: "freshness", policy: "block", probe: TEST_GUARD.probe },
    ]);

    // The record ARCHIVE keeps: both commits read whole by tree-sitter, stamped with its rules and packages, against the neighbour's anchor.
    const read = {
      parser: expect.stringMatching(
        /^keel-syntax\/\d+ web-tree-sitter@[\d.]+ tree-sitter-typescript@[\d.]+$/,
      ),
      skipped: [],
    };
    const record = await Effect.runPromise(
      EvidenceStore.use((store) => store.get(POOL_ORG, answer.derivationRef)).pipe(
        Effect.provide(EvidenceStoreR2(env.ARCHIVE)),
      ),
    );
    expect(record).toEqual({
      kind: "keel.derivation/1",
      changeId: c.changeId,
      revision: 1,
      repo: workspace.repo,
      base,
      head,
      seeds: ["src/authz/sessions.ts"],
      anchors: [{ subject: "authz.sessions", anchors: [SESSION_OF] }],
      readings: { base: read, head: read },
      effects: [effect],
      undecided: [],
    });

    // The subjects heard the derivation from this change's outbox, and what they tell the neighbour's agent is theirs to flush.
    await drainOutbox(c.stub);
    await Promise.all(hearing.map((subject) => drainOutbox(subject)));
  });

  it("[d21.pool.derive-purity] core's derivation, run here on tree-sitter and the Project DO's live anchors, finds the `console.info` a head puts in the function a neighbour relies on being pure, and Precheck commits `purity is false` on the neighbour's subject", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const projectId: ProjectId = makeId("prj", ulid());
    const c = await changeUnderTest(projectId, "project");
    const neighbour = await changeUnderTest(projectId, "project");
    const hearing = [key("bench.price"), key("bench")].map((subject) =>
      drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, subject)))),
    );
    // Another live change relies on `price` being pure; drained, so the project's index holds its anchor.
    ok(await neighbour.declare("declare-neighbour", { premises: [PRICE_IS_PURE] }));
    await drainOutbox(neighbour.stub);

    // This change declares nothing, and adds a log to `price`.
    const lease = ok(await c.declare("declare-1")).change.lease.id;
    const workspace = ok(decodeExit(ChangeCodecs.workspace, await c.stub.workspace()));
    const { base, head } = await pushedOver(
      c,
      workspace,
      { [PRICE_FILE]: PURE_PRICE },
      { [PRICE_FILE]: LOGGED_PRICE },
    );
    const answer = await derivedFrom(c, workspace, base, head, [PRICE_FILE]);
    expect(answer.subjects).toEqual(["bench.price"]);
    // The control: the base read as its own head takes no impure step it did not take.
    expect((await derivedFrom(c, workspace, base, base, [PRICE_FILE])).subjects).toEqual([]);

    const anchors = [{ path: PRICE_FILE, symbol: "price", commit: head }];
    const effect = {
      proposition: {
        subject: "bench.price",
        predicate: "purity",
        relation: "is",
        value: false,
        anchors,
        gloss: "price calls console.info",
      },
      anchors,
      declared: false,
      method: "extractor",
      evidenceClass: "ruling",
    };
    const record = await Effect.runPromise(
      EvidenceStore.use((store) => store.get(POOL_ORG, answer.derivationRef)).pipe(
        Effect.provide(EvidenceStoreR2(env.ARCHIVE)),
      ),
    );
    expect(record).toMatchObject({
      seeds: [PRICE_FILE],
      anchors: [{ subject: "bench.price", anchors: [PRICE_IS_PURE.anchors?.[0]] }],
      effects: [effect],
      undecided: [],
    });

    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(base));
      await m.mockStepResult({ name: "diff" }, touched([PRICE_FILE]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult({ name: "flow" }, flow(JSON.stringify({ predicates: {} })));
      await m.mockStepResult({ name: "guards" }, guards([]));
      await m.mockStepResult({ name: "derive" }, { _tag: "Done", value: answer });
    });
    ok(
      decodeExit(
        ChangeCodecs.submit,
        await c.stub.submit({
          agentId: c.agentId,
          leaseId: lease,
          commitSha: head,
          idempotencyKey: "s-1",
        }),
      ),
    );
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");
    const log = await c.log();
    expect(log.find((e) => e.type === "EffectsDerived")?.payload).toEqual({
      _tag: "EffectsDerived",
      changeId: c.changeId,
      revision: 1,
      effects: [effect],
      derivationRef: answer.derivationRef,
    });

    await drainOutbox(c.stub);
    await Promise.all(hearing.map((subject) => drainOutbox(subject)));
  });

  it("[d21.pool.derive-unreadable] refuses a commit whose diff could not be read without deriving from it", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    // No derive step is mocked: taken, it would parse a workspace no code host here serves, and never settle.
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult(
        { name: "diff" },
        { _tag: "Done", value: { _tag: "Unreadable", reason: `ObjectNotFound ${BASE}` } },
      );
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult({ name: "flow" }, flow());
      await m.mockStepResult({ name: "guards" }, guards());
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    const log = await c.log();
    expect(log.at(-1)?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: [`precheck:unreadable:ObjectNotFound ${BASE}`],
    });
    expect(log.map((e) => e.type)).not.toContain("EffectsDerived");
  });

  it("[d12.pool.refused] bounces a change to a guard path, with next actions and a ruling verdict", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const { c, commitSha, submit } = await pushed();
    const derive = await kept(c, commitSha);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched([".keel/guards/g1.test.ts", "src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult({ name: "flow" }, flow());
      await m.mockStepResult({ name: "guards" }, guards());
      await m.mockStepResult({ name: "derive" }, derive);
    });
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    const bounced = (await c.log()).at(-1);
    expect(bounced?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: ["precheck:guard:.keel/guards/g1.test.ts (.keel/guards/**)"],
      nextActions: [{ kind: "call", operationId: "submit" }],
    });
  });

  it("[t5.pool.namespace-step] refuses a submission to a project with no place, naming the project, and reads nothing more of it", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const unplaced: ProjectId = makeId("prj", ulid());
    // No later step is mocked: were the instance to go on, ancestry would read the code host.
    const { c, submit } = await pushed([], await changeUnderTest(unplaced, "memory", false));
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    const log = await c.log();
    // Nothing was derived or compiled between the start and the refusal.
    expect(log.map((e) => e.type).slice(-3)).toEqual([
      "ChangeSubmitted",
      "PrecheckStarted",
      "ChangeBounced",
    ]);
    expect(log.at(-1)?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: [
        `precheck:project-unplaced:project ${unplaced} belongs to no namespace, so nothing of this change can be kept or verified`,
      ],
      nextActions: [{ kind: "escalate", args: { projectId: unplaced } }],
    });
  });

  it("[d12.pool.stale] completes, moving nothing, when the change has moved on", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const { c, commitSha, submit } = await pushed();
    const derive = await kept(c, commitSha);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult({ name: "flow" }, flow());
      await m.mockStepResult({ name: "guards" }, guards());
      await m.mockStepResult({ name: "derive" }, derive);
    });
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");
    const before = await c.log();

    // A second instance for the same revision: the change is already queued.
    const id = `precheck-late-${ulid()}`;
    await using late = await introspectWorkflowInstance(env.PRECHECK, id);
    await env.PRECHECK.create({
      id,
      params: { changeId: c.changeId, revision: 1, commitSha, eventId: "evt-late" },
    });
    await late.waitForStatus("complete");

    expect(await c.log()).toEqual(before);
    expect((await c.current()).state).toBe("queued");
  });

  it("[d21.pool.derived-stale] stops at the derivation, deciding and compiling nothing, when the change moved on before it was committed", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    const { c, commitSha, submit } = await pushed();
    const derive = await kept(c, commitSha);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "ancestry" }, descends(BASE));
      await m.mockStepResult({ name: "diff" }, touched(["src/a.ts"]));
      await m.mockStepResult({ name: "policy" }, policy([]));
      await m.mockStepResult({ name: "flow" }, flow());
      await m.mockStepResult({ name: "guards" }, guards());
      await m.mockStepResult({ name: "derive" }, derive);
      // What the Change DO answers a derivation for a revision it has left.
      await m.mockStepResult({ name: "derived" }, { _tag: "Stale", reason: "driven by hand" });
    });
    await submit();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    // The clean submission that compiles in [d12.pool.compiled] ends here at its start: no plan, no verdict, no queue.
    const types = (await c.log()).map((e) => e.type);
    expect(types.at(-1)).toBe("PrecheckStarted");
    expect(types).not.toContain("PlanCompiled");
    expect(types).not.toContain("ChangeQueued");
    expect(types).not.toContain("VerdictIssued");
  });

  it("[c14.pool.diverged] bounces a commit off its base, naming rebase, without reading its paths", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult(
        { name: "ancestry" },
        { _tag: "Done", value: { _tag: "Diverged", base: BASE, commit: "c".repeat(40) } },
      );
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    const [instance] = await workflows.get();
    await instance?.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    expect((await c.log()).at(-1)?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: [`precheck:not-on-base:${"c".repeat(40)} does not descend from ${BASE}`],
      nextActions: [{ kind: "call", operationId: "rebase", args: { base: BASE } }],
    });
  });

  it("[c14.pool.base-carried] the outbox starts Precheck with the base ChangeSubmitted carries, the grant's", async () => {
    await using workflows = await introspectWorkflow(env.PRECHECK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "start" }, { _tag: "Stale", reason: "driven by hand" });
    });
    const { c } = await submitted();
    await vi.waitFor(async () => expect(await workflows.get()).toHaveLength(1), WAIT);
    await (await workflows.get())[0]?.waitForStatus("complete");

    const event = (await c.log()).find((e) => e.type === "ChangeSubmitted");
    if (event === undefined) throw new Error("no ChangeSubmitted on the change's log");
    // The params the outbox builds: the event's payload, plus its id.
    const payload =
      typeof event.payload === "object" && event.payload !== null ? event.payload : {};
    const params = Schema.decodeUnknownSync(PrecheckParams)({ ...payload, eventId: event.eventId });
    const { baseSha } = await c.current();
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(params.baseSha).toBe(baseSha);
  });

  it("[c14.pool.no-base] refuses a submission event that carries no base, as precheck:no-base", async () => {
    const inert = await inertPrecheck();
    const { c, commitSha } = await submitted();
    await vi.waitFor(async () => expect(await inert.get()).toHaveLength(1), WAIT);
    await (await inert.get())[0]?.waitForStatus("complete");
    await inert.dispose();

    // An instance started as one from before ChangeSubmitted carried its base.
    const id = `precheck-old-${ulid()}`;
    await using old = await introspectWorkflowInstance(env.PRECHECK, id);
    await env.PRECHECK.create({
      id,
      params: { changeId: c.changeId, revision: 1, commitSha, eventId: "evt-old" },
    });
    await old.waitForStatus("complete");

    expect((await c.current()).state).toBe("bounced");
    expect((await c.log()).at(-1)?.payload).toMatchObject({
      _tag: "ChangeBounced",
      reasons: [
        `precheck:no-base:${commitSha} was submitted without the base it is judged against`,
      ],
      nextActions: [{ kind: "call", operationId: "submit" }],
    });
  });

  it("[d12.pool.not-found] fails permanently for a change that was never declared", async () => {
    const id = `precheck-missing-${ulid()}`;
    await using instance = await introspectWorkflowInstance(env.PRECHECK, id);
    await env.PRECHECK.create({
      id,
      params: {
        changeId: makeId("chg", ulid()),
        revision: 1,
        commitSha: "a".repeat(40),
        eventId: "evt-missing",
      },
    });
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
  });
});
