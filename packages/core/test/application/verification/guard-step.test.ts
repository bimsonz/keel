import { Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  JS_TS_SUITE_PACK,
  type ProbeRun,
  type StepRunner,
  withGuards,
} from "../../../src/application/verification/index.ts";
import {
  EvidenceMissing,
  EvidenceStore,
  ProbeRunner,
  ProbeRunnerUnavailable,
  type ProbeRunRequest,
} from "../../../src/application/ports/index.ts";
import {
  CommitSha,
  ContentHash,
  contentHashOf,
  type Json,
  NamespaceId,
} from "../../../src/domain/kernel/index.ts";
import {
  coerce,
  compile,
  type FlowPlan,
  type PlanStep,
  type StepReport,
} from "../../../src/domain/verification/index.ts";

const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);
const CANDIDATE = hash(7);
const PINNED = hash(42);

/** The namespace every call names, and the only one the stores below keep anything for. */
const NAMESPACE = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");

/** The js-ts pack's plan for a change: its one step, the suite. */
const SUITE_PLAN = Result.getOrThrow(
  compile(
    undefined,
    { baseCommit: CommitSha.make("a".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    JS_TS_SUITE_PACK,
  ),
);
const [SUITE] = SUITE_PLAN.steps;
if (SUITE === undefined) throw new Error("the suite plan has a suite step");
/** A guard of freshness, running its admitted probe, under its predicate's advise policy. */
const GUARD: PlanStep = {
  ...SUITE,
  id: "keel.guard.freshness",
  kind: "probe",
  evidenceCeiling: "proof",
  outcomes: ["pass", "fail", "abstain"],
  guards: { predicate: "freshness", policy: "advise", probe: PINNED },
};
const PLAN: FlowPlan = { ...SUITE_PLAN, steps: [GUARD, SUITE] };

/** A runner for every other step: it records that it was asked. */
const otherwise =
  (asked: string[]): StepRunner<never> =>
  (step) =>
    Effect.sync((): StepReport => {
      asked.push(step.id);
      return {
        stepId: step.id,
        outcome: "pass",
        evidenceClass: "proof",
        tier: step.tier,
        durationMs: 0,
      };
    });

function guarded(answer: (r: ProbeRunRequest) => ProbeRun | "unavailable") {
  const requests: ProbeRunRequest[] = [];
  const asked: string[] = [];
  const layer = Layer.succeed(
    ProbeRunner,
    ProbeRunner.of({
      run: (request) =>
        Effect.suspend(() => {
          requests.push(request);
          const a = answer(request);
          return a === "unavailable"
            ? Effect.fail(new ProbeRunnerUnavailable({ reason: "keel-verify did not answer" }))
            : Effect.succeed(a);
        }),
    }),
  );
  const stored = new Map<string, Json>();
  const evidence = Layer.succeed(
    EvidenceStore,
    EvidenceStore.of({
      put: (namespace, document) =>
        Effect.sync(() => {
          const ref = contentHashOf(document);
          stored.set(`${namespace} ${ref}`, document);
          return ref;
        }),
      get: (namespace, ref) => {
        const document = stored.get(`${namespace} ${ref}`);
        return document === undefined
          ? Effect.fail(new EvidenceMissing({ hash: ref }))
          : Effect.succeed(document);
      },
    }),
  );
  const run = (step: PlanStep) =>
    Effect.runPromise(
      withGuards(
        NAMESPACE,
        CANDIDATE,
        otherwise(asked),
      )(step, undefined).pipe(Effect.provide(Layer.mergeAll(layer, evidence))),
    );
  return { requests, asked, run, stored };
}

const ran = (outcome: "pass" | "fail" | "n/a"): ProbeRun => ({
  _tag: "ran",
  outcome,
  reason: outcome,
  observations: ["[probe] x"],
});

describe("a guard step runs the probe its plan pins", () => {
  it("[guard.pinned-probe] runs exactly the pinned probe against the candidate, and nothing else", async () => {
    const g = guarded(() => ran("pass"));
    const report = await g.run(GUARD);
    expect(g.requests).toEqual([
      {
        namespace: "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
        probe: PINNED,
        world: "AB",
        worldBundle: CANDIDATE,
        run: 1,
      },
    ]);
    expect(report).toMatchObject({ stepId: GUARD.id, outcome: "pass", tier: { tier: 1 } });
    expect(g.asked).toEqual([]);
  });

  it("[guard.evidence] stores what the run said, with the predicate and the pinned probe, as the evidence the report cites", async () => {
    const g = guarded(() => ran("fail"));
    const report = await g.run(GUARD);
    const ref = Schema.decodeUnknownSync(ContentHash)(report.resultRef);
    expect(g.stored.get(`org_01JZ8PT2C4E6G8J0M2N4Q6S8V0 ${ref}`)).toEqual({
      stepId: GUARD.id,
      outcome: "fail",
      guard: { predicate: "freshness", probe: PINNED },
      reason: "fail",
      observations: ["[probe] x"],
    });
  });

  it("[guard.pinned-probe] hands every step that guards nothing to the plan's other runner", async () => {
    const g = guarded(() => ran("pass"));
    await g.run(SUITE);
    expect(g.asked).toEqual([SUITE.id]);
    expect(g.requests).toEqual([]);
  });

  it("[guard.outcomes] reports the probe's pass and fail as they are", async () => {
    const reports = await Promise.all(
      (["pass", "fail"] as const).map((outcome) => guarded(() => ran(outcome)).run(GUARD)),
    );
    expect(reports.map((r) => coerce(PLAN, r).outcome)).toEqual(["pass", "fail"]);
  });

  it("[guard.na-abstains] reports the probe's n/a, which coerce reads as abstain: the tenet's precondition is gone", async () => {
    const report = await guarded(() => ran("n/a")).run(GUARD);
    expect(report.outcome).toBe("n/a");
    expect(coerce(PLAN, report).outcome).toBe("abstain");
  });

  it("[guard.infra-abstains] abstains on a harness error or a runner that could not run, never passing", async () => {
    const harness = await guarded(() => ({
      _tag: "harness-error",
      reason: "two tests",
      observations: [],
    })).run(GUARD);
    const unavailable = await guarded(() => "unavailable").run(GUARD);
    for (const report of [harness, unavailable]) {
      expect(report.failure).toBeDefined();
      expect(coerce(PLAN, report).outcome).toBe("abstain");
    }
    expect(harness.failure).toBe("schema");
    expect(unavailable.failure).toBe("unavailable");
  });
});
