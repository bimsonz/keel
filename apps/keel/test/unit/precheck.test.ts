import { describe, expect, it } from "@effect/vitest";
import {
  checkAncestry,
  decidePrecheck,
  needsRuling,
  type PrecheckFindings,
  type PrecheckSubmission,
  precheckReads,
  readStoredPlan,
  recordPlan,
  refuseSubmission,
  startPrecheck,
} from "@keeltown/core/application/verification";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { AdmittedGuard } from "@keeltown/core/domain/verification";
import {
  CommitSha,
  contentHashOf,
  Glob,
  makeId,
  type NamespaceId,
  type ProjectId,
  type WorkspaceId,
} from "@keeltown/core/kernel";
import {
  AdmittedGuards,
  ChangePrecheck,
  CodeHost,
  FlowSpecSource,
  PlanStore,
  type PrecheckCompiled,
  type PrecheckWorkspace,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  type FixtureFiles,
  makeAdmittedGuardsMemory,
  makeDecisionsMemory,
  projectEvents,
  ruledConflict,
  makeChangePrecheckMemory,
  makeCodeHostMemory,
  makePlanStoreMemory,
  makeProjectsMemory,
  sampleNamespace,
} from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";
import { FlowSpecSourceCodeHost } from "../../src/adapters/driven/gitcore/flow-spec-source.ts";

const changeId = makeId("chg", "01JZD12D12D12D12D12D12D12D");
const projectId: ProjectId = makeId("prj", "01JZD12D12D12D12D12D12D12D");
const workspaceId: WorkspaceId = makeId("wsp", "01JZD12D12D12D12D12D12D12D");
const repo = { namespace: "keel-ws-00", name: "ws-d12" };
const MAIN = "refs/heads/main";
const KEEL_TRUNK = "refs/heads/keel/trunk";
const BASE_FILES: FixtureFiles = {
  "src/a.ts": "export const a = 1;\n",
  "infra/main.tf": 'resource "x" "y" {}\n',
  ".keel/guards/g1.test.ts": "test('g1', () => {});\n",
};

/** A read Precheck asked of the code host, with its arguments after the repo. */
type HostRead =
  | {
      readonly method: "isAncestor";
      readonly ancestor: CommitSha;
      readonly descendant: CommitSha;
      readonly stopAt: readonly CommitSha[];
    }
  | { readonly method: "diffTrees"; readonly base: CommitSha; readonly head: CommitSha }
  | { readonly method: "flow"; readonly base: CommitSha };

/**
 * Precheck's world in memory: a workspace repo granted at the base files'
 * commit, the agent's commits on its main and trunk's on its keel/trunk (as a
 * rebase puts them), the change submitted on that workspace, and the
 * project's settings. Precheck's ancestry walks and diffs are recorded in
 * `reads`. `run` takes the Workflow's steps in order.
 */
function precheckWorld(
  options: {
    readonly protectedPaths?: readonly string[];
    readonly guards?: readonly AdmittedGuard[];
    readonly refusedGuards?: readonly string[];
    readonly baseFiles?: FixtureFiles;
    /** The subjects the change declared, as its workspace view serves them. */
    readonly subjects?: readonly SubjectKey[];
  } = {},
) {
  const code = makeCodeHostMemory();
  const changes = makeChangePrecheckMemory();
  const projects = makeProjectsMemory();
  const guards = makeAdmittedGuardsMemory();
  /** Keel's memory of the project's rulings: empty until a case makes a ruling's events arrive. */
  const decisions = makeDecisionsMemory();
  for (const g of options.guards ?? [])
    Effect.runSync(
      Effect.gen(function* () {
        yield* (yield* AdmittedGuards).admit(
          projectId,
          { guardId: g.guardId, probe: g.probe, proposition: g.tenet.proposition },
          [],
        );
      }).pipe(Effect.provide(guards.layer)),
    );
  for (const id of options.refusedGuards ?? [])
    Effect.runSync(guards.plantWithoutProposition(projectId, id));
  const plans = makePlanStoreMemory();
  /** What reached the plan store and the Change DO, in order. */
  const recorded: string[] = [];
  /** Each plan Precheck recorded on the Change DO, as it was sent. */
  const compiledPlans: PrecheckCompiled[] = [];
  projects.setSettings(projectId, {
    protectedPaths: (options.protectedPaths ?? ["infra/**"]).map((g) => Glob.make(g)),
    maxBatchSize: 4,
    verification: "required",
    visibility: "private",
  });
  const reads: HostRead[] = [];
  const recording = Layer.effect(
    CodeHost,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      return CodeHost.of({
        ...host,
        isAncestor: (at, ancestor, descendant, stopAt) => {
          reads.push({ method: "isAncestor", ancestor, descendant, stopAt });
          return host.isAncestor(at, ancestor, descendant, stopAt);
        },
        diffTrees: (at, base, head) => {
          reads.push({ method: "diffTrees", base, head });
          return host.diffTrees(at, base, head);
        },
      });
    }),
  ).pipe(Layer.provide(code.layer));
  const flows = Layer.effect(
    FlowSpecSource,
    Effect.gen(function* () {
      const source = yield* FlowSpecSource;
      return FlowSpecSource.of({
        read: (at, base) => {
          reads.push({ method: "flow", base });
          return source.read(at, base);
        },
      });
    }),
  ).pipe(Layer.provide(FlowSpecSourceCodeHost), Layer.provide(code.layer));
  const ordered = Layer.mergeAll(
    Layer.effect(
      PlanStore,
      Effect.gen(function* () {
        const store = yield* PlanStore;
        return PlanStore.of({
          ...store,
          put: (namespace, plan) =>
            store
              .put(namespace, plan)
              .pipe(
                Effect.tap(() => Effect.sync(() => void recorded.push(`put ${plan.planHash}`))),
              ),
        });
      }),
    ).pipe(Layer.provide(plans.layer)),
    Layer.effect(
      ChangePrecheck,
      Effect.gen(function* () {
        const precheck = yield* ChangePrecheck;
        return ChangePrecheck.of({
          ...precheck,
          compiled: (id, plan) =>
            precheck.compiled(id, plan).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  compiledPlans.push(plan);
                  recorded.push(
                    `compiled ${plan.planHash}${plan.needsRuling === true ? " needs-ruling" : ""}`,
                  );
                }),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(changes.layer)),
  );
  const layer = Layer.mergeAll(
    recording,
    flows,
    ordered,
    projects.layer,
    guards.layer,
    decisions.layer,
  );
  /** Commits `files` as the whole tree on `ref`, on top of its head and then `merged`. */
  const commitOn = (ref: string, files: FixtureFiles, merged?: readonly CommitSha[]) =>
    Effect.gen(function* () {
      return yield* (yield* CodeHostFixture).commit(repo, ref, files, merged);
    }).pipe(Effect.provide(code.layer));

  /** Creates the workspace repo, granted at the base files' commit on main. */
  const grant = () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* CodeHost).create(repo);
      }).pipe(Effect.provide(code.layer));
      return yield* commitOn(MAIN, options.baseFiles ?? BASE_FILES);
    });

  /** A push to the workspace's main: `files` as the whole tree, merging `merged`. */
  const push = (files: FixtureFiles, merged?: readonly CommitSha[]) =>
    commitOn(MAIN, files, merged);

  /** Trunk moves on past the grant: `files` on keel/trunk, parented on `granted`, as a rebase puts it there. */
  const trunk = (granted: CommitSha, files: FixtureFiles) => commitOn(KEEL_TRUNK, files, [granted]);

  /**
   * Seeds the change as submitted at revision 1 on `commitSha`, judged
   * against `base` (none: an older submission that carries no base). The
   * workspace view serves the change's current base, the grant's when none,
   * and its flow is read there.
   */
  const submit = (
    granted: CommitSha,
    commitSha: CommitSha,
    base: CommitSha | undefined,
    instanceId = "precheck-evt_1",
  ): PrecheckSubmission => {
    const workspace: PrecheckWorkspace = {
      workspaceId,
      repo,
      baseSha: base ?? granted,
      grantedSha: granted,
      flowAt: base ?? granted,
      projectId,
      subjects: options.subjects ?? [],
      intent: { revision: 1, goal: "the change under Precheck", footprint: [], premises: [] },
    };
    changes.submit(changeId, 1, workspace);
    return { changeId, revision: 1, commitSha, baseSha: base, instanceId };
  };

  /**
   * Seeds a proposal as submitted at revision 1 on `commitSha`, a fork's
   * commit judged against `base`, where the fork last met the upstream, in a
   * workspace granted at the upstream's head `granted`: its flow is read there.
   */
  const propose = (
    granted: CommitSha,
    commitSha: CommitSha,
    base: CommitSha,
  ): PrecheckSubmission => {
    changes.submit(changeId, 1, {
      workspaceId,
      repo,
      baseSha: base,
      grantedSha: granted,
      flowAt: granted,
      projectId,
      subjects: options.subjects ?? [],
      intent: { revision: 1, goal: "the proposal under Precheck", footprint: [], premises: [] },
    });
    return { changeId, revision: 1, commitSha, baseSha: base, instanceId: "precheck-evt_1" };
  };

  /** Grants the workspace and submits the last of `pushes` (each a whole tree) at revision 1, on the grant. */
  const submitted = (pushes: readonly FixtureFiles[], instanceId = "precheck-evt_1") =>
    Effect.gen(function* () {
      const granted = yield* grant();
      let head: CommitSha = granted;
      for (const files of pushes) head = yield* push(files);
      return submit(granted, head, granted, instanceId);
    });

  /**
   * The Workflow's steps, in order, on these use-cases and its reads, bar the
   * derivation: `derive` and `derived` are taken in precheck-derive.test.ts.
   * Nothing is derived here, so the plan's subjects are the workspace's.
   */
  const run = (
    submission: PrecheckSubmission,
    namespace: NamespaceId = sampleNamespace,
    /** The start's answer as the Workflow's history replays it, its start not taken again. */
    started?: PrecheckWorkspace,
  ) =>
    Effect.gen(function* () {
      const workspace = started ?? (yield* startPrecheck(submission));
      const ancestry = yield* checkAncestry(workspace, submission);
      const findings: PrecheckFindings =
        ancestry._tag === "Descends"
          ? {
              ancestry,
              ...(yield* Effect.all(precheckReads(workspace, submission, ancestry))),
              subjects: workspace.subjects,
            }
          : { ancestry };
      const decision = decidePrecheck(findings, namespace);
      if (decision._tag === "Refuse") yield* refuseSubmission(submission, decision);
      else yield* recordPlan(namespace, submission, decision);
      return decision;
    }).pipe(Effect.provide(layer));

  /** The plan the store holds under `hash`, read back and verified. */
  const storedPlan = (hash: Parameters<typeof readStoredPlan>[0]) =>
    Result.getOrThrow(
      readStoredPlan(
        hash,
        plans.plans.get(
          `ns/org_01JZ8PT2C4E6G8J0M2N4Q6S8V0/plans/${hash.slice("sha256:".length)}`,
        ) ?? "",
      ),
    );

  return {
    code,
    changes,
    decisions,
    layer,
    reads,
    recorded,
    compiledPlans,
    storedPlan,
    grant,
    push,
    trunk,
    submit,
    propose,
    submitted,
    run,
  };
}

const FLOW = ".keel/flow.json";

/** An admitted guard of freshness on `authz.sessions`, anchored at src/a.ts. */
const GUARD: AdmittedGuard = {
  guardId: makeId("grd", "01JZD12D12D12D12D12D12D12D"),
  probe: contentHashOf({ probe: "authz.sessions" }),
  tenet: {
    id: makeId("tnt", "01JZD12D12D12D12D12D12D12D"),
    proposition: {
      subject: Schema.decodeUnknownSync(SubjectKey)("authz.sessions"),
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
      anchors: [{ path: "src/a.ts", commit: CommitSha.make("a".repeat(40)) }],
    },
  },
};

/** A flow like keel/keel's: its own check on every path, and package.json a human-class path. */
const UPSTREAM_FLOW = {
  flow: { _tag: "step", step: "upstream.check" },
  steps: [
    {
      id: "upstream.check",
      kind: "deterministic",
      evidenceCeiling: "proof",
      outcomes: ["pass", "fail", "abstain"],
      budget: { usd: 0.05, cpuMs: 1_200_000, tokens: 0 },
      appliesTo: { paths: ["**"], subjects: [] },
      run: { command: "pnpm test", timeoutMs: 1_200_000 },
    },
  ],
  humanClassPaths: ["package.json"],
};

const withFile = (path: string, data = "changed\n"): FixtureFiles => ({
  ...BASE_FILES,
  [path]: data,
});

/** The steps the shrink rule watches in the plan of a change compiled on a base whose flow is `flow` (none: no flow file). */
const countedUnder = (flow: object | undefined) => {
  const base = flow === undefined ? BASE_FILES : { ...BASE_FILES, [FLOW]: JSON.stringify(flow) };
  const world = precheckWorld({ baseFiles: base });
  return Effect.gen(function* () {
    const decision = yield* world.run(
      yield* world.submitted([{ ...base, "src/a.ts": "changed\n" }]),
    );
    if (decision._tag !== "Compile") throw new Error(`not compiled: ${decision._tag}`);
    const plan = Result.getOrThrow(readStoredPlan(decision.planHash, decision.plan));
    return plan.steps.filter((s) => s.counted === true).map((s) => s.id);
  });
};

describe("Precheck", () => {
  it.effect("[d12.guard-refused] refuses a change to a guard, citing it, with next actions", () => {
    const world = precheckWorld();
    return Effect.gen(function* () {
      const decision = yield* world.run(
        yield* world.submitted([withFile(".keel/guards/g1.test.ts")]),
      );
      expect(decision).toMatchObject({
        _tag: "Refuse",
        reasons: ["precheck:guard:.keel/guards/g1.test.ts (.keel/guards/**)"],
      });
      expect(world.changes.stateOf(changeId)).toBe("bounced");
      expect(world.changes.calls.map((c) => c.method)).toEqual([
        "precheckStarted",
        "precheckRefused",
      ]);
    });
  });

  it.effect(
    "[precheck.start-replayed] a pass whose start ran on the code before a deploy, its answer replayed from the Workflow's history, goes on under the new steps: they bind the run that start recorded and read the workspace it answered, so it may derive and it compiles; once the change has moved on, the same replay is stale",
    () => {
      const world = precheckWorld();
      const moved = precheckWorld();
      return Effect.gen(function* () {
        // The start as the code before the deploy took it: the change was seeded with no commit to check.
        const submission = yield* world.submitted([withFile("src/a.ts")]);
        const cached = yield* startPrecheck(submission).pipe(Effect.provide(world.layer));
        const deriving = Effect.flatMap(ChangePrecheck, (precheck) =>
          precheck.deriving(submission.changeId, submission),
        );
        yield* deriving.pipe(Effect.provide(world.layer));
        const decision = yield* world.run(submission, sampleNamespace, cached);
        expect(decision._tag).toBe("Compile");
        expect(world.changes.stateOf(changeId)).toBe("queued");

        const before = yield* moved.submitted([withFile("src/a.ts")]);
        const replayed = yield* startPrecheck(before).pipe(Effect.provide(moved.layer));
        // Submitted again since: the run that start recorded is no longer the change's.
        moved.changes.submit(changeId, 1, replayed);
        const stale = yield* Effect.flip(deriving.pipe(Effect.provide(moved.layer)));
        const compiled = yield* Effect.flip(moved.run(before, sampleNamespace, replayed));
        expect([stale._tag, compiled._tag]).toEqual(["ChangeStateRefused", "ChangeStateRefused"]);
        expect(moved.changes.stateOf(changeId)).toBe("submitted");
      });
    },
  );

  it.effect(
    "[d12.protected-refused] refuses a protected path, read from the project's settings",
    () => {
      const world = precheckWorld({ protectedPaths: ["infra/**"] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("infra/main.tf")]));
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: ["precheck:protected:infra/main.tf (infra/**)"],
        });
        if (decision._tag !== "Refuse") return;
        expect(decision.nextActions.map((a) => a.kind)).toEqual(["call", "escalate"]);
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect(
    "[d12.protected-refused] lets the same path through a project that does not protect it",
    () => {
      const world = precheckWorld({ protectedPaths: [] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("infra/main.tf")]));
        expect(decision._tag).toBe("Compile");
      });
    },
  );

  it.effect(
    "[d12.clean-compiles] compiles a clean change's plan from its base, and records it",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("src/a.ts")]));
        expect(decision).toMatchObject({ _tag: "Compile", steps: 1 });
        expect(world.changes.stateOf(changeId)).toBe("queued");
        expect(world.changes.calls.map((c) => c.method)).toEqual([
          "precheckStarted",
          "planCompiled",
        ]);
      });
    },
  );

  it.effect(
    "[d12.base-diff] diffs against the base, so a guard edit in an earlier push still counts",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        // The guard changes in the first push; the submitted second push only touches src.
        const guarded = withFile(".keel/guards/g1.test.ts");
        const decision = yield* world.run(
          yield* world.submitted([guarded, { ...guarded, "src/a.ts": "export const a = 2;\n" }]),
        );
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: ["precheck:guard:.keel/guards/g1.test.ts (.keel/guards/**)"],
        });
      });
    },
  );

  it.effect(
    "[d12.base-missing] refuses, with a resubmit next action, a commit the workspace lacks",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const submission = yield* world.submitted([withFile("src/a.ts")]);
        const decision = yield* world.run({
          ...submission,
          commitSha: CommitSha.make("f".repeat(40)),
        });
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: [`precheck:unreadable:ObjectNotFound ${"f".repeat(40)}`],
          nextActions: [{ kind: "call", operationId: "submit" }],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect(
    "[flow-ruling.compiles] compiles a flow change with its human-class gate, and records it parked for a maintainer's ruling",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile(".keel/flow.yaml")]));
        if (decision._tag !== "Compile") throw new Error(`not compiled: ${decision._tag}`);
        const plan = Result.getOrThrow(readStoredPlan(decision.planHash, decision.plan));
        expect(plan.steps.map((s) => s.id)).toContain("keel.human-class");
        expect(needsRuling(decision)).toBe(true);
        expect(world.recorded).toEqual([
          `put ${decision.planHash}`,
          `compiled ${decision.planHash} needs-ruling`,
        ]);
        expect(world.changes.stateOf(changeId)).toBe("parked");
      });
    },
  );

  it.effect("[flow-ruling.plain] a change that leaves the flow alone needs no ruling", () => {
    const world = precheckWorld();
    return Effect.gen(function* () {
      const decision = yield* world.run(yield* world.submitted([withFile("src/a.ts")]));
      if (decision._tag !== "Compile") throw new Error(`not compiled: ${decision._tag}`);
      expect(needsRuling(decision)).toBe(false);
      expect(world.recorded).toEqual([`put ${decision.planHash}`, `compiled ${decision.planHash}`]);
      expect(world.changes.stateOf(changeId)).toBe("queued");
    });
  });

  it.effect(
    "[flow-ruling.agent-namespace] refuses a flow change in an agent's own namespace, where no person can rule, and says to split its flow edits out; a person's own namespace is asked",
    () => {
      const agents = precheckWorld();
      const persons = precheckWorld();
      return Effect.gen(function* () {
        const refused = yield* agents.run(
          yield* agents.submitted([withFile(".keel/flow.yaml")]),
          makeId("agt", "01JZ8PT2C4E6G8J0M2N4Q6S8V7"),
        );
        const asked = yield* persons.run(
          yield* persons.submitted([withFile(".keel/flow.yaml")]),
          makeId("usr", "01JZ8PT2C4E6G8J0M2N4Q6S8V7"),
        );

        expect(refused).toMatchObject({
          _tag: "Refuse",
          reasons: ["precheck:plan-gap:keel.human-class"],
          nextActions: [
            { kind: "call", operationId: "submit", args: { steps: ["keel.human-class"] } },
          ],
        });
        expect(JSON.stringify(refused)).toMatch(
          /A change to \.keel\/flow\.yaml needs a person's ruling, and no person can rule in an agent's own namespace/,
        );
        expect(agents.changes.stateOf(changeId)).toBe("bounced");
        expect(agents.recorded).toEqual([]);
        expect(asked._tag).toBe("Compile");
        expect(persons.changes.stateOf(changeId)).toBe("parked");
      });
    },
  );

  it.effect(
    "[flow-ruling.project-paths] a path the base's flow adds to the human-class paths holds the gate as .keel/flow does, and the decision names the paths the ruling is about; a change touching none of them needs no ruling",
    () => {
      const base = { ...BASE_FILES, [FLOW]: JSON.stringify({ humanClassPaths: ["package.json"] }) };
      const ruled = precheckWorld({ baseFiles: base });
      const plain = precheckWorld({ baseFiles: base });
      return Effect.gen(function* () {
        const decision = yield* ruled.run(
          yield* ruled.submitted([
            { ...base, "package.json": '{"scripts":{"test":"true"}}', "src/a.ts": "changed\n" },
          ]),
        );
        if (decision._tag !== "Compile") throw new Error(`not compiled: ${decision._tag}`);
        expect(needsRuling(decision)).toBe(true);
        expect(decision.ruledPaths).toEqual(["package.json"]);
        expect(ruled.changes.stateOf(changeId)).toBe("parked");
        const untouched = yield* plain.run(
          yield* plain.submitted([{ ...base, "src/a.ts": "changed\n" }]),
        );
        if (untouched._tag !== "Compile") throw new Error(`not compiled: ${untouched._tag}`);
        expect([needsRuling(untouched), untouched.ruledPaths]).toEqual([false, undefined]);
        expect(plain.changes.stateOf(changeId)).toBe("queued");
      });
    },
  );

  it.effect(
    "[precheck.proposal-flow-upstream] compiles a proposal under the flow at the upstream head its workspace was granted at, never its base's, and flags the human-class paths it edits; a change still reads its base's",
    () => {
      const base = { ...BASE_FILES, [FLOW]: JSON.stringify({}) };
      const upstream = { ...base, [FLOW]: JSON.stringify(UPSTREAM_FLOW) };
      const work = {
        ...base,
        "package.json": '{"scripts":{"test":"true"}}',
        "src/a.ts": "changed\n",
      };
      const proposals = precheckWorld({ baseFiles: base });
      const changes = precheckWorld({ baseFiles: base });
      return Effect.gen(function* () {
        const forked = yield* proposals.grant();
        const head = yield* proposals.trunk(forked, upstream);
        const proposed = yield* proposals.run(
          proposals.propose(head, yield* proposals.push(work), forked),
        );
        if (proposed._tag !== "Compile") throw new Error(`not compiled: ${proposed._tag}`);
        expect(proposals.reads.filter((r) => r.method === "flow")).toEqual([
          { method: "flow", base: head },
        ]);
        expect(proposals.storedPlan(proposed.planHash).steps.map((s) => s.id)).toEqual(
          expect.arrayContaining(["upstream.check", "keel.human-class"]),
        );
        expect(proposed.ruledPaths).toEqual(["package.json"]);
        expect(proposals.compiledPlans.map((p) => p.ruledPaths)).toEqual([["package.json"]]);

        const granted = yield* changes.grant();
        yield* changes.trunk(granted, upstream);
        const plain = yield* changes.run(
          changes.submit(granted, yield* changes.push(work), granted),
        );
        if (plain._tag !== "Compile") throw new Error(`not compiled: ${plain._tag}`);
        expect(changes.reads.filter((r) => r.method === "flow")).toEqual([
          { method: "flow", base: granted },
        ]);
        expect(changes.storedPlan(plain.planHash).steps.map((s) => s.id)).not.toContain(
          "upstream.check",
        );
        expect([needsRuling(plain), plain.ruledPaths]).toEqual([false, undefined]);
      });
    },
  );

  it.effect(
    "[flow-ruling.shrink-from-base] the base's flow decides whether the shrink rule watches a plan's suite: on unless it says off",
    () => {
      return Effect.gen(function* () {
        const watched = yield* countedUnder(undefined);
        expect(watched.length).toBeGreaterThan(0);
        expect(yield* countedUnder({ shrink: "park" })).toEqual(watched);
        expect(yield* countedUnder({ shrink: "off" })).toEqual([]);
      });
    },
  );

  it.effect(
    "[d21.flow-from-base] reads the flow at the submission's base, never its head, and carries the base's predicate policy",
    () => {
      const base = {
        ...BASE_FILES,
        [FLOW]: JSON.stringify({ predicates: { freshness: "block" } }),
      };
      const world = precheckWorld({ baseFiles: base });
      return Effect.gen(function* () {
        const submission = yield* world.submitted([{ ...base, "src/a.ts": "changed\n" }]);
        const decision = yield* world.run(submission);
        expect(decision).toMatchObject({
          _tag: "Compile",
          predicatePolicy: { freshness: "block" },
        });
        expect(world.reads.filter((r) => r.method === "flow")).toEqual([
          { method: "flow", base: submission.baseSha },
        ]);
        expect(submission.baseSha).not.toBe(submission.commitSha);
      });
    },
  );

  it.effect(
    "[d21.pack-detected] compiles the pack detection chose at the base: a worker app runs its suite and its typecheck",
    () => {
      const base = { ...BASE_FILES, "wrangler.jsonc": "{}\n" };
      const world = precheckWorld({ baseFiles: base });
      return Effect.gen(function* () {
        const decision = yield* world.run(
          yield* world.submitted([{ ...base, "src/a.ts": "changed\n" }]),
        );
        if (decision._tag !== "Compile") throw new Error(`refused: ${decision.reasons.join("; ")}`);
        expect(decision.pack).toBe("worker-app: wrangler.jsonc");
        expect(
          world
            .storedPlan(decision.planHash)
            .steps.map((s) => s.id)
            .toSorted(),
        ).toEqual(["js-ts.suite", "worker-app.typecheck"]);
      });
    },
  );

  it.effect(
    "[d21.guards-selected] selects an admitted guard the change is exposed to, under the base's policy, and no other",
    () => {
      const base = {
        ...BASE_FILES,
        [FLOW]: JSON.stringify({ predicates: { freshness: "block" } }),
      };
      const exposed = precheckWorld({ baseFiles: base, guards: [GUARD] });
      const apart = precheckWorld({ baseFiles: base, guards: [GUARD] });
      return Effect.gen(function* () {
        const touching = yield* exposed.run(
          yield* exposed.submitted([{ ...base, "src/a.ts": "changed\n" }]),
        );
        if (touching._tag !== "Compile") throw new Error(`refused: ${touching.reasons.join("; ")}`);
        const guarded = exposed.storedPlan(touching.planHash).steps.filter((s) => s.guards);
        expect(guarded.map((s) => [s.id, s.guards?.probe, s.guards?.policy])).toEqual([
          [`guard:${GUARD.guardId}`, GUARD.probe, "block"],
        ]);
        const elsewhere = yield* apart.run(
          yield* apart.submitted([{ ...base, "src/b.ts": "new\n" }]),
        );
        if (elsewhere._tag !== "Compile")
          throw new Error(`refused: ${elsewhere.reasons.join("; ")}`);
        expect(apart.storedPlan(elsewhere.planHash).steps.some((s) => s.guards)).toBe(false);
      });
    },
  );

  it.effect(
    "[d21.guards-selected] a change relying on the guarded subject is exposed to its guard, whatever it touches",
    () => {
      const world = precheckWorld({ guards: [GUARD], subjects: [GUARD.tenet.proposition.subject] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("src/b.ts")]));
        if (decision._tag !== "Compile") throw new Error(`refused: ${decision.reasons.join("; ")}`);
        expect(world.storedPlan(decision.planHash).steps.some((s) => s.guards)).toBe(true);
      });
    },
  );

  it.effect(
    "[d21.stored-before-compiled] stores the plan before PlanCompiled names its hash, so a queued hash always resolves",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("src/a.ts")]));
        if (decision._tag !== "Compile") throw new Error(`refused: ${decision.reasons.join("; ")}`);
        expect(world.recorded).toEqual([
          `put ${decision.planHash}`,
          `compiled ${decision.planHash}`,
        ]);
        expect(world.storedPlan(decision.planHash).steps).toHaveLength(decision.steps);
      });
    },
  );

  it.effect(
    "[s2.guard-cites] a guard that holds an active decision compiles to block under the default advise, its step naming the decision",
    () => {
      const world = precheckWorld({ guards: [GUARD], subjects: [GUARD.tenet.proposition.subject] });
      const ruled = ruledConflict(projectEvents(projectId), GUARD.guardId);
      return Effect.gen(function* () {
        for (const event of [
          ...ruled.conflict,
          ruled.recorded("premise-holds"),
          ruled.resolved([ruled.other]),
        ])
          yield* world.decisions.arrive(event);
        const decision = yield* world.run(yield* world.submitted([withFile("src/b.ts")]));
        if (decision._tag !== "Compile") throw new Error(`refused: ${decision.reasons.join("; ")}`);
        const [guarded] = world.storedPlan(decision.planHash).steps.filter((s) => s.guards);

        expect(guarded?.guards).toMatchObject({
          policy: "block",
          decision: { id: ruled.decisionId, summary: "The premise holds" },
        });
        expect(guarded?.because).toContain(`holds decision ${ruled.decisionId}: The premise holds`);
      });
    },
  );

  it.effect(
    "[s2.guard-cites] a guard that holds no decision keeps the project's policy, and its step names none",
    () => {
      const world = precheckWorld({ guards: [GUARD], subjects: [GUARD.tenet.proposition.subject] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("src/b.ts")]));
        if (decision._tag !== "Compile") throw new Error(`refused: ${decision.reasons.join("; ")}`);
        const [guarded] = world.storedPlan(decision.planHash).steps.filter((s) => s.guards);

        expect(guarded?.guards?.policy).toBe("advise");
        expect(guarded?.guards?.decision).toBeUndefined();
        expect(guarded?.because).not.toContain("holds decision");
      });
    },
  );

  it.effect(
    "[s2.guard-cites] a guard whose decision was superseded, or whose ruling went for the effect, takes the project's policy again",
    () => {
      const ended = precheckWorld({ guards: [GUARD], subjects: [GUARD.tenet.proposition.subject] });
      const overturned = precheckWorld({
        guards: [GUARD],
        subjects: [GUARD.tenet.proposition.subject],
      });
      const superseded = ruledConflict(projectEvents(projectId), GUARD.guardId);
      const forEffect = ruledConflict(projectEvents(projectId), GUARD.guardId);
      return Effect.gen(function* () {
        for (const event of [
          ...superseded.conflict,
          superseded.recorded("premise-holds"),
          superseded.resolved([superseded.other]),
          superseded.superseded(),
        ])
          yield* ended.decisions.arrive(event);
        for (const event of [
          ...forEffect.conflict,
          forEffect.recorded("effect-stands"),
          forEffect.resolved([forEffect.holder]),
        ])
          yield* overturned.decisions.arrive(event);
        for (const world of [ended, overturned]) {
          const decision = yield* world.run(yield* world.submitted([withFile("src/b.ts")]));
          if (decision._tag !== "Compile")
            throw new Error(`refused: ${decision.reasons.join("; ")}`);
          const [guarded] = world.storedPlan(decision.planHash).steps.filter((s) => s.guards);

          expect(guarded?.guards?.policy).toBe("advise");
          expect(guarded?.guards?.decision).toBeUndefined();
        }
      });
    },
  );

  it.effect(
    "[d21.guards-refused] a guard the repo cannot admit is shown in the run, and the plan still compiles",
    () => {
      const bad = makeId("grd", "01JZD21D21D21D21D21D21D21D");
      const world = precheckWorld({ refusedGuards: [bad] });
      return Effect.gen(function* () {
        const decision = yield* world.run(yield* world.submitted([withFile("src/a.ts")]));
        expect(decision).toMatchObject({
          _tag: "Compile",
          guardsRefused: [{ guardId: bad, reason: expect.stringMatching(/proposition/) }],
        });
      });
    },
  );

  it.effect(
    "[d21.flow-invalid] a base whose flow does not compile is refused with an escalation, and nothing is stored",
    () => {
      const base = { ...BASE_FILES, [FLOW]: "{" };
      const world = precheckWorld({ baseFiles: base });
      return Effect.gen(function* () {
        const decision = yield* world.run(
          yield* world.submitted([{ ...base, "src/a.ts": "changed\n" }]),
        );
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: [expect.stringMatching(/^precheck:flow-invalid:\.keel\/flow\.json is not JSON/)],
          nextActions: [{ kind: "escalate", args: { path: FLOW } }],
        });
        expect(world.recorded).toEqual([]);
      });
    },
  );

  it.effect("[d12.replay] a replayed run commits nothing new", () => {
    const world = precheckWorld();
    return Effect.gen(function* () {
      const submission = yield* world.submitted([withFile("src/a.ts")]);
      const first = yield* world.run(submission);
      const again = yield* world.run(submission);
      expect(again).toEqual(first);
      expect(world.changes.calls).toHaveLength(2);
    });
  });

  it.effect(
    "[d12.stale] a resubmitted change refuses the old revision's Precheck, which moves nothing",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const submission = yield* world.submitted([withFile("src/a.ts")]);
        const error = yield* Effect.flip(world.run({ ...submission, revision: 0 }));
        expect(error._tag).toBe("ChangeStateRefused");
        expect(world.changes.stateOf(changeId)).toBe("submitted");
        expect(world.changes.calls).toHaveLength(0);
      });
    },
  );
});

describe("Precheck's ancestry", () => {
  it.effect(
    "[c14.descends] compiles a commit that descends from its base, after one ancestry walk stopped at the grant",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const work = yield* world.push(withFile("src/a.ts"));
        const decision = yield* world.run(world.submit(granted, work, granted));
        expect(decision._tag).toBe("Compile");
        expect(world.reads).toEqual([
          { method: "isAncestor", ancestor: granted, descendant: work, stopAt: [granted] },
          { method: "diffTrees", base: granted, head: work },
          { method: "flow", base: granted },
        ]);
      });
    },
  );

  it.effect(
    "[c14.diverged] refuses a commit that does not descend from the rebased base, naming rebase and the merge, before any diff",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const trunk = yield* world.trunk(granted, withFile("src/b.ts", "trunk\n"));
        // Rebased onto trunk's head, then pushed without merging keel/trunk.
        const work = yield* world.push(withFile("src/a.ts"));
        const decision = yield* world.run(world.submit(granted, work, trunk));
        expect(decision).toEqual({
          _tag: "Refuse",
          reasons: [`precheck:not-on-base:${work} does not descend from ${trunk}`],
          nextActions: [
            {
              kind: "call",
              operationId: "rebase",
              title: expect.stringContaining("git fetch origin keel/trunk && git merge FETCH_HEAD"),
              args: { base: trunk },
            },
          ],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
        expect(world.reads.map((r) => r.method)).toEqual(["isAncestor"]);
      });
    },
  );

  it.effect(
    "[c14.merged] passes a merge of keel/trunk, diffed from the rebased base, so trunk's own guard change is not the agent's",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const onTrunk = withFile(".keel/guards/g1.test.ts", "test('g1 tightened', () => {});\n");
        const trunk = yield* world.trunk(granted, onTrunk);
        // The agent's own work, then its merge of keel/trunk: parents [work, trunk].
        yield* world.push(withFile("src/a.ts"));
        const merge = yield* world.push({ ...onTrunk, "src/a.ts": "changed\n" }, [trunk]);
        const decision = yield* world.run(world.submit(granted, merge, trunk));
        expect(decision._tag).toBe("Compile");
        expect(world.changes.stateOf(changeId)).toBe("queued");
        expect(world.reads).toEqual([
          { method: "isAncestor", ancestor: trunk, descendant: merge, stopAt: [granted] },
          { method: "diffTrees", base: trunk, head: merge },
          { method: "flow", base: trunk },
        ]);
      });
    },
  );

  it.effect(
    "[c14.missing] refuses, never as a defect, a commit whose history the workspace lacks, naming the missing object and the commit",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const lost = CommitSha.make("e".repeat(40));
        const merge = yield* world.push(withFile("src/a.ts"), [lost]);
        const decision = yield* world.run(world.submit(granted, merge, granted));
        expect(decision).toEqual({
          _tag: "Refuse",
          reasons: [`precheck:unreadable:ObjectNotFound ${lost}, in the history of ${merge}`],
          nextActions: [expect.objectContaining({ kind: "call", operationId: "submit" })],
        });
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );

  it.effect(
    "[c14.missing] refuses a submitted commit the workspace does not hold, naming it, before any diff",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const absent = CommitSha.make("f".repeat(40));
        const decision = yield* world.run(world.submit(granted, absent, granted));
        expect(decision).toMatchObject({
          _tag: "Refuse",
          reasons: [`precheck:unreadable:ObjectNotFound ${absent}`],
        });
        expect(world.reads.map((r) => r.method)).toEqual(["isAncestor"]);
      });
    },
  );

  it.effect(
    "[c14.stop-at] walks from the submission's base with the grant as its only stop, even after a rebase moved the base",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const trunk = yield* world.trunk(granted, withFile("src/b.ts", "trunk\n"));
        const merge = yield* world.push(
          { ...withFile("src/b.ts", "trunk\n"), "src/a.ts": "changed\n" },
          [trunk],
        );
        yield* world.run(world.submit(granted, merge, trunk));
        expect(world.reads[0]).toEqual({
          method: "isAncestor",
          ancestor: trunk,
          descendant: merge,
          stopAt: [granted],
        });
      });
    },
  );

  it.effect(
    "[c14.no-base] refuses a submission that carries no base, reading nothing, never falling back to the workspace's",
    () => {
      const world = precheckWorld();
      return Effect.gen(function* () {
        const granted = yield* world.grant();
        const work = yield* world.push(withFile("src/a.ts"));
        const decision = yield* world.run(world.submit(granted, work, undefined));
        expect(decision).toEqual({
          _tag: "Refuse",
          reasons: [`precheck:no-base:${work} was submitted without the base it is judged against`],
          nextActions: [expect.objectContaining({ kind: "call", operationId: "submit" })],
        });
        expect(world.reads).toEqual([]);
        expect(world.changes.stateOf(changeId)).toBe("bounced");
      });
    },
  );
});
