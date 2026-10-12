import { Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CheckPlan,
  type ProbeParties,
  TIER2_STEP_IDS,
  trunkCheckPlan,
  WORKER_APP_PACK,
  worldCheckCell,
  worldCheckJobs,
  worldCheckRunSteps,
  worldCheckSteps,
} from "../../../src/application/verification/index.ts";
import {
  FlowSpecSource,
  type FlowSources,
  ObjectNotFound,
  PlanStore,
} from "../../../src/application/ports/index.ts";
import { SubjectKey } from "../../../src/domain/coordination/index.ts";
import { CommitSha, ContentHash, makeId } from "../../../src/domain/kernel/index.ts";
import {
  compile,
  type FlowPlan,
  type PlanStep,
  type StepReport,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);

/** The worker-app pack's plan: two proof steps in Tier 2, the suite and the typecheck. */
const PLAN = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: sha("a"), touchedPaths: ["src/a.ts"], subjects: [], facts: {} },
    WORKER_APP_PACK,
  ),
);

const report = (step: PlanStep, outcome: string): StepReport => ({
  stepId: step.id,
  outcome,
  evidenceClass: "proof",
  tier: step.tier,
  durationMs: 1,
});

const ulid = (n: number): string => String(n).padStart(26, "0");
const A = makeId("chg", ulid(1));
const B = makeId("chg", ulid(2));
const key = Schema.decodeUnknownSync(SubjectKey)("authz.permission-evaluation");
const proposition = { subject: key, predicate: "freshness", relation: "is", value: "x" } as const;
const PARTIES: ProbeParties = {
  A,
  B,
  premise: { holder: A, proposition },
  effect: { changeId: B, proposition },
};

/** trunkCheckPlan over a flow source answering `sources` (or failing) and a plan store keeping what it is given. */
const trunkPlan = (sources: FlowSources | "unreadable") => {
  const stored: FlowPlan[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      FlowSpecSource,
      FlowSpecSource.of({
        read: (repo, commit) =>
          sources === "unreadable"
            ? Effect.fail(new ObjectNotFound({ repo, oid: commit }))
            : Effect.succeed(sources),
      }),
    ),
    Layer.succeed(
      PlanStore,
      PlanStore.of({
        put: (plan) =>
          Effect.sync(() => {
            stored.push(plan);
            return plan.planHash;
          }),
        get: () => Effect.die("unused"),
      }),
    ),
  );
  return Effect.runPromise(
    trunkCheckPlan({ namespace: "keel-core", name: "prj-staging" }, sha("b")).pipe(
      Effect.provide(layer),
    ),
  ).then((plan) => ({ plan, stored }));
};

describe("world checks", () => {
  it("[world-check.steps] a world check runs the plan's Tier 2 steps Keel has a runner for, in plan order, and nothing else", () => {
    const other: PlanStep = {
      ...PLAN.steps[0]!,
      id: "custom.lint",
      tier: { tier: 2, reason: "a Tier 2 step with no runner" },
    };
    const lower: PlanStep = {
      ...PLAN.steps[0]!,
      id: "guard.freshness",
      tier: { tier: 1, reason: "a probe" },
    };
    const plan: FlowPlan = { ...PLAN, steps: [lower, ...PLAN.steps, other] };
    expect(worldCheckSteps(plan).map((s) => s.id)).toEqual(
      PLAN.steps.map((s) => s.id).filter((id) => TIER2_STEP_IDS.includes(id)),
    );
    expect(worldCheckSteps(PLAN).map((s) => s.id)).toEqual(["js-ts.suite", "worker-app.typecheck"]);
  });

  it("[world-check.run-once] a world's instance runs each distinct step of its checks' plans once, in the order first met", () => {
    const typecheckOnly: FlowPlan = {
      ...PLAN,
      steps: PLAN.steps.filter((s) => s.id === "worker-app.typecheck"),
    };
    expect(worldCheckRunSteps([PLAN, PLAN]).map((s) => s.id)).toEqual([
      "js-ts.suite",
      "worker-app.typecheck",
    ]);
    expect(worldCheckRunSteps([typecheckOnly, PLAN]).map((s) => s.id)).toEqual([
      "worker-app.typecheck",
      "js-ts.suite",
    ]);
    expect(worldCheckRunSteps([])).toEqual([]);
  });

  it("[world-check.cell] a check fails when any step fails, passes when every step passes, and is n/a, saying why, otherwise", () => {
    const steps = worldCheckSteps(PLAN);
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("pass", "fail", "abstain", "missing"), {
          minLength: steps.length,
          maxLength: steps.length,
        }),
        (outcomes) => {
          const reports = steps.flatMap((step, i) =>
            outcomes[i] === "missing" ? [] : [report(step, outcomes[i] ?? "pass")],
          );
          const cell = worldCheckCell(PLAN, reports);
          const expected = outcomes.includes("fail")
            ? "fail"
            : outcomes.every((o) => o === "pass")
              ? "pass"
              : "n/a";
          expect(cell.outcome).toBe(expected);
          expect(cell.reason === undefined).toBe(expected === "pass");
        },
      ),
    );
  });

  it("[world-check.cell] a plan with no step a world check can run is n/a, never a pass", () => {
    const plan: FlowPlan = { ...PLAN, steps: [] };
    expect(worldCheckCell(plan, [])).toEqual({
      outcome: "n/a",
      reason: expect.stringMatching(/no Tier 2 step/),
    });
  });

  it("[world-check.jobs] one job per world: trunk's suite on trunk under trunk's plan, each party's in its world, both in AB, each naming the change whose plan it reads", () => {
    const worlds = { trunk: hash(1), A: hash(2), B: hash(3), AB: hash(4) };
    const trunk: CheckPlan = { _tag: "Planned", planHash: hash(10) };
    const [ofA, ofB]: CheckPlan[] = [
      { _tag: "OfChange", changeId: A },
      { _tag: "OfChange", changeId: B },
    ];
    const conflict = { projectId: makeId("prj", ulid(3)), key, conflictId: makeId("cfl", ulid(4)) };
    expect(worldCheckJobs(conflict, PARTIES, worlds, trunk)).toEqual([
      {
        ...conflict,
        world: "trunk",
        bundle: hash(1),
        checks: [{ check: "suite:trunk", plan: trunk }],
      },
      {
        ...conflict,
        world: "A",
        bundle: hash(2),
        checks: [{ check: `suite:${A}`, plan: ofA }],
      },
      {
        ...conflict,
        world: "B",
        bundle: hash(3),
        checks: [{ check: `suite:${B}`, plan: ofB }],
      },
      {
        ...conflict,
        world: "AB",
        bundle: hash(4),
        checks: [
          { check: `suite:${A}`, plan: ofA },
          { check: `suite:${B}`, plan: ofB },
        ],
      },
    ]);
    // An unplanned trunk is carried as it is, with its reason.
    const unplanned: CheckPlan = { _tag: "Unplanned", reason: "trunk's flow is invalid" };
    expect(worldCheckJobs(conflict, PARTIES, worlds, unplanned)[0]?.checks).toEqual([
      { check: "suite:trunk", plan: unplanned },
    ]);
  });

  it("[world-check.trunk-plan] trunk's check runs the plan compiled from trunk head's flow with no subjects and no guards, stored by its hash", async () => {
    const { plan, stored } = await trunkPlan({ rootPaths: ["src"] });
    expect(stored).toHaveLength(1);
    expect(plan).toEqual({ _tag: "Planned", planHash: stored[0]?.planHash });
    expect(stored[0]?.steps.map((s) => s.id)).toContain("js-ts.suite");
    expect(stored[0]?.steps.some((s) => s.guards !== undefined)).toBe(false);
  });

  it("[world-check.trunk-plan] a trunk flow that cannot be read or is invalid leaves trunk's check unplanned, saying why", async () => {
    expect((await trunkPlan("unreadable")).plan).toEqual({
      _tag: "Unplanned",
      reason: expect.stringMatching(/could not be read: ObjectNotFound/),
    });
    const invalid = await trunkPlan({ rootPaths: [".keel"], flowJson: "{ not json" });
    expect(invalid.plan).toMatchObject({ _tag: "Unplanned" });
    expect(invalid.stored).toEqual([]);
  });
});
