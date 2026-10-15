import { Effect, Schema } from "effect";
import { QuotaExceeded } from "../../domain/identity/index.ts";
import type { ContentHash, NamespaceId, NextAction } from "../../domain/kernel/index.ts";
import type { PlanStep, StepReport } from "../../domain/verification/index.ts";
import { Ids, NamespaceUsage } from "../ports/index.ts";
import type { SettledVerdict } from "./verify-candidate.ts";

/**
 * What a verification spends of its namespace's container-minutes, counted
 * with NamespaceUsage: one attempt of the plan's Tier 2 steps admitted before
 * any runs, then settled to what the runners reported once the verdict is in.
 * A deps build is counted once a day for its install digest (`ensureDeps`). A refusal runs
 * nothing: over the day's limit the batch is parked unrun until the reset,
 * and a halted namespace's change is bounced, through no fault of its own.
 */

const MINUTE_MS = 60_000;

/**
 * The minutes one attempt of a plan's Tier 2 steps may take: each Tier 2
 * step's deadline (`deadlineMs`, undefined for a step no runner takes, which
 * abstains unrun), each rounded up to the minute.
 */
export const planMinutes = (
  steps: readonly PlanStep[],
  deadlineMs: (step: PlanStep) => number | undefined,
): number =>
  steps.reduce((sum, step) => {
    if (step.tier.tier !== 2) return sum;
    const ms = deadlineMs(step);
    return ms === undefined ? sum : sum + Math.ceil(ms / MINUTE_MS);
  }, 0);

/** The minutes a verification's Tier 2 steps took, as their runners reported them, rounded up. */
export const usedMinutes = (reports: readonly StepReport[]): number =>
  Math.ceil(
    reports
      .filter((report) => report.tier.tier === 2)
      .reduce((sum, report) => sum + Math.max(0, report.durationMs), 0) / MINUTE_MS,
  );

/** What a verification was admitted: its minutes, or the refusal it runs nothing on. A schema, since a Workflow step persists it. */
export const Admission = Schema.Union([
  Schema.TaggedStruct("Admitted", { minutes: Schema.Number }),
  Schema.TaggedStruct("Refused", { exceeded: QuotaExceeded }),
]);
export type Admission = typeof Admission.Type;

/** The key a verification is admitted under: its instance's, so a replayed step counts nothing again. */
const admitKey = (instanceId: string) => `verify:${instanceId}`;

/**
 * Admits a verification's minutes against its namespace's container-minutes
 * (`planMinutes`), under its instance's key. Asked even for none, so a halted
 * namespace verifies nothing.
 */
export const admitVerification = Effect.fn("verification/admitVerification")(function* (
  namespace: NamespaceId,
  instanceId: string,
  minutes: number,
) {
  const usage = yield* NamespaceUsage;
  return yield* usage.admit(namespace, "container-minutes", minutes, admitKey(instanceId)).pipe(
    Effect.as<Admission>({ _tag: "Admitted", minutes }),
    Effect.catchTag("QuotaExceeded", (exceeded) =>
      Effect.succeed<Admission>({ _tag: "Refused", exceeded }),
    ),
  );
});

/**
 * Settles an admitted verification to the minutes its runners reported: what
 * was admitted and not used is given back, and what ran past it is counted,
 * once, under its instance's key.
 */
export const settleMinutes = Effect.fn("verification/settleMinutes")(function* (
  namespace: NamespaceId,
  instanceId: string,
  admitted: number,
  reports: readonly StepReport[],
) {
  const usage = yield* NamespaceUsage;
  yield* usage.record(
    namespace,
    "container-minutes",
    usedMinutes(reports) - admitted,
    `${admitKey(instanceId)}:settle`,
  );
});

/** A verdict, as settled. */
const settled = (verdict: SettledVerdict): SettledVerdict => verdict;

/** What the owner of a halted namespace's change does: ask for it to be resumed, then submit again. */
export const haltedActions = (namespace: NamespaceId): readonly NextAction[] => [
  {
    kind: "escalate",
    title: `Verification spend is stopped for ${namespace}: ask whoever runs this Keel to resume it`,
  },
  {
    kind: "call",
    title: "Submit the change again once its namespace's verification is resumed",
    operationId: "submit",
  },
];

/**
 * The verdict of a verification its namespace refused, which ran nothing.
 * Over the day's limit it is a park, unrun, with when the limit resets: the
 * lane forms nothing before then. Halted, it is a bounce that is no fault of
 * the change's, telling its owner what to do.
 */
export const settleRefused = Effect.fn("verification/settleRefused")(function* (
  namespace: NamespaceId,
  planHash: ContentHash,
  exceeded: QuotaExceeded,
) {
  const verdictId = yield* (yield* Ids).next("vrd");
  if (exceeded.reason === "halted")
    return settled({
      verdictId,
      outcome: "bounce",
      planHash,
      evidence: [
        `namespace.halted: verification spend is stopped for ${namespace}; the change itself passed nothing and failed nothing`,
      ],
      failingTests: [],
      nextActions: haltedActions(namespace),
      halted: true,
    });
  return settled({
    verdictId,
    outcome: "park",
    planHash,
    evidence: [
      `quota.exceeded: ${namespace} has used ${exceeded.used} of its ${exceeded.limit} ${exceeded.kind} for today, and this verification needs ${exceeded.requested}; nothing ran`,
    ],
    failingTests: [],
    nextActions: exceeded.nextActions,
    unrun: true,
    ...(exceeded.retryAt === undefined ? {} : { retryAt: exceeded.retryAt }),
  });
});
