/** Compiled Verification Plans for tests: what Precheck would store for a change, before KeelVerify runs it. */
import { JS_TS_SUITE_PACK, WORKER_APP_PACK } from "@keeltown/core/application/verification";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { type AdmittedGuard, compile, type FlowPlan } from "@keeltown/core/domain/verification";
import { CommitSha, ContentHash, makeId, type PredicatePolicy } from "@keeltown/core/kernel";
import { Result, Schema } from "effect";

/** The base the plans below are compiled from. */
export const PLAN_BASE = Schema.decodeUnknownSync(CommitSha)("a".repeat(40));

const SUBJECT = Schema.decodeUnknownSync(SubjectKey)("authz.sessions");

/** An admitted guard of freshness on `authz.sessions`, running the probe bundle `sha256:9…`. */
export const TEST_GUARD: AdmittedGuard = {
  guardId: makeId("grd", "01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  probe: Schema.decodeUnknownSync(ContentHash)(`sha256:${"9".repeat(64)}`),
  tenet: {
    id: makeId("tnt", "01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
    proposition: {
      subject: SUBJECT,
      predicate: "freshness",
      relation: "at-most",
      value: "per-request",
    },
  },
};

const facts = { baseCommit: PLAN_BASE, touchedPaths: ["src/sessions.ts"], facts: {} };

/** The plan Precheck compiles for a js-ts change with no flow of its own: the suite, in Tier 2. */
export const suitePlan = (): FlowPlan =>
  Result.getOrThrow(compile(undefined, { ...facts, subjects: [] }, JS_TS_SUITE_PACK));

/** The worker-app pack's plan: the suite and the typecheck, side by side. */
export const workerAppPlan = (): FlowPlan =>
  Result.getOrThrow(compile(undefined, { ...facts, subjects: [] }, WORKER_APP_PACK));

/** The worker-app plan for a change exposed to TEST_GUARD, under `policy` for freshness. */
export const guardedPlan = (policy: PredicatePolicy = "advise"): FlowPlan =>
  Result.getOrThrow(
    compile(
      undefined,
      {
        ...facts,
        subjects: [SUBJECT],
        admittedGuards: [TEST_GUARD],
        predicatePolicy: { freshness: policy },
      },
      WORKER_APP_PACK,
    ),
  );
