import { Effect } from "effect";
import type { ChangeId } from "../../domain/kernel/index.ts";
import { Clock, ProbeChanges, type Subscriber } from "../ports/index.ts";
import { partyEventType, type ProbeSteps } from "./probe-workflow.ts";
import type { CheckPlan, PlannedCheck } from "./world-check.ts";

/** How long a world's checks wait, in all, for their parties' Prechecks to answer: then a check still waiting is n/a, saying so. */
export const WORLD_CHECK_PLAN_WAIT_MS = 5 * 60 * 1000;

/** The address a waiting check's change tells of its plan, or of the end that left it without one: this instance. */
export const worldCheckSubscriber = (instanceId: string): Subscriber =>
  `workflow:KeelWorldCheck/${instanceId}`;

/** A check's plan once read: the hash to run, or why there is none. */
export type ResolvedCheckPlan = Exclude<CheckPlan, { readonly _tag: "OfChange" }>;

/** A check with its plan read: what the instance runs and records. */
export interface ResolvedCheck {
  readonly check: string;
  readonly plan: ResolvedCheckPlan;
}

const unplanned = (reason: string): ResolvedCheckPlan => ({ _tag: "Unplanned", reason });

/**
 * The plan a party's suite check runs, read when the check runs. A
 * change whose Precheck has answered gives its plan, or none in the state it
 * is in. One whose Precheck is still running is waited for, never polled: the
 * read records this instance as a one-shot subscriber in the same call, and
 * the instance sleeps until the change's next PlanCompiled, or the event that
 * ends it without one, then reads again. Past `deadline` the check has no
 * plan, and says so.
 */
export const partyCheckPlan = (
  check: string,
  changeId: ChangeId,
  instanceId: string,
  deadline: number,
  steps: ProbeSteps,
) =>
  Effect.gen(function* () {
    const changes = yield* ProbeChanges;
    const clock = yield* Clock;
    const subscriber = worldCheckSubscriber(instanceId);
    const late = unplanned(
      `${changeId}'s Precheck compiled no plan within ${WORLD_CHECK_PLAN_WAIT_MS / 60_000} minutes`,
    );
    for (let n = 1; ; n++) {
      const read = yield* steps.step(
        `plan of ${check} ${n}`,
        changes
          .awaitPlan(changeId, subscriber)
          .pipe(
            Effect.catchTag("ChangeNotFound", () => Effect.succeed({ _tag: "Missing" } as const)),
          ),
      );
      if (read._tag === "Compiled")
        return { _tag: "Planned", planHash: read.planHash } satisfies ResolvedCheckPlan;
      if (read._tag === "None")
        return unplanned(`${changeId} is ${read.state} with no compiled plan`);
      if (read._tag === "Missing") return unplanned(`${changeId} is not a change`);
      const now = yield* steps.step(`clock ${check} ${n}`, clock.now);
      if (now >= deadline) return late;
      const heard = yield* steps.waitFor(
        `change ${check} ${n}`,
        partyEventType(changeId),
        deadline - now,
      );
      if (!heard) return late;
    }
  });

/**
 * Every check of one world with its plan read, in the job's order. A check
 * that names its plan, or why it has none, is kept as it is; a party's is
 * read from its change by `partyCheckPlan`. The waits share one deadline,
 * WORLD_CHECK_PLAN_WAIT_MS from the instance's first read, kept as a step so
 * a replay counts from the same moment: AB's two parties cost one wait.
 */
export const resolveCheckPlans = (
  checks: readonly PlannedCheck[],
  instanceId: string,
  steps: ProbeSteps,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    const resolved: ResolvedCheck[] = [];
    let deadline: number | undefined;
    for (const { check, plan } of checks) {
      if (plan._tag !== "OfChange") {
        resolved.push({ check, plan });
        continue;
      }
      if (deadline === undefined)
        deadline = (yield* steps.step("started", clock.now)) + WORLD_CHECK_PLAN_WAIT_MS;
      resolved.push({
        check,
        plan: yield* partyCheckPlan(check, plan.changeId, instanceId, deadline, steps),
      });
    }
    return resolved;
  });
