import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  checkAncestry,
  decidePrecheck,
  diffSubmission,
  PrecheckDecision,
  type PrecheckFindings,
  type PrecheckSubmission,
  precheckPolicy,
  recordPlan,
  refuseSubmission,
  startPrecheck,
} from "@keeltown/core/application/verification";
import { ChangeId, CommitSha } from "@keeltown/core/kernel";
import { Cause, type Effect, Exit, type ManagedRuntime, Option, Schema } from "effect";
import { precheckRuntime } from "../../../composition/workflow.ts";

/**
 * What the outbox starts Precheck with: `ChangeSubmitted`'s payload, plus the
 * event's id. `baseSha` is optional only because older events lack it, and a
 * submission without it is refused.
 */
export const PrecheckParams = Schema.Struct({
  changeId: ChangeId,
  revision: Schema.Int,
  commitSha: CommitSha,
  baseSha: Schema.optional(CommitSha),
  eventId: Schema.String,
});
export type PrecheckParams = typeof PrecheckParams.Encoded;

/** How an instance ended, as its output says. */
export type PrecheckOutcome =
  | { readonly outcome: "refused"; readonly verdictId: string; readonly reasons: readonly string[] }
  | { readonly outcome: "compiled"; readonly planHash: string }
  /** The change moved on (resubmitted, withdrawn) while this instance ran: nothing to do. */
  | { readonly outcome: "stale"; readonly step: string; readonly reason: string };

type Settled<A> =
  | { readonly _tag: "Done"; readonly value: A }
  | { readonly _tag: "Stale"; readonly reason: string };

/**
 * Runs one step's use-case. A stale revision (ChangeStateRefused) settles as
 * Stale, so the instance completes with the reason; a change or project that
 * does not exist fails permanently; anything else throws, and the step retries.
 */
async function settle<A, E extends { readonly _tag: string }, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, R>,
): Promise<Settled<A>> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return { _tag: "Done", value: exit.value };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw Cause.squash(exit.cause);
  const error: { readonly _tag: string } = failure.value;
  if (error._tag === "ChangeStateRefused" && "state" in error && "command" in error)
    return {
      _tag: "Stale",
      reason: `the change is ${String(error.state)}, so ${String(error.command)} was refused`,
    };
  throw new NonRetryableError(error._tag);
}

/** The value of a step that cannot be stale: its use-case never refuses a revision. */
const done = <A>(settled: Settled<A>): A => {
  if (settled._tag === "Stale") throw new Error(`unexpected stale step: ${settled.reason}`);
  return settled.value;
};

/**
 * Precheck, started by `ChangeSubmitted` as `precheck-<eventId>`: refuse a
 * submitted commit that does not descend from the submission's base; diff
 * one that does against that base, refuse guard and protected paths (and,
 * until D2.1, any plan KeelVerify cannot run yet), otherwise compile the
 * Verification Plan. Steps: `start`, `ancestry`, then `diff` and `policy` for
 * a commit on its base, `decide`, then `refuse` or `compile`. Each write is
 * idempotent by this instance's id, so a replayed step commits nothing new.
 */
export class Precheck extends WorkflowEntrypoint<Env, PrecheckParams> {
  override async run(
    event: WorkflowEvent<PrecheckParams>,
    step: WorkflowStep,
  ): Promise<PrecheckOutcome> {
    const params = Schema.decodeUnknownOption(PrecheckParams)(event.payload);
    if (Option.isNone(params)) throw new NonRetryableError("not a ChangeSubmitted payload");
    const submission: PrecheckSubmission = {
      changeId: params.value.changeId,
      revision: params.value.revision,
      commitSha: params.value.commitSha,
      baseSha: params.value.baseSha,
      instanceId: event.instanceId,
    };
    const runtime = precheckRuntime(this.env);
    try {
      const started = await step.do("start", () => settle(runtime, startPrecheck(submission)));
      if (started._tag === "Stale")
        return { outcome: "stale", step: "start", reason: started.reason };
      const workspace = started.value;
      const ancestry = done(
        await step.do("ancestry", () => settle(runtime, checkAncestry(workspace, submission))),
      );
      const findings: PrecheckFindings =
        ancestry._tag === "Descends"
          ? {
              ancestry,
              touched: done(
                await step.do("diff", () =>
                  settle(runtime, diffSubmission(workspace, ancestry.base, submission.commitSha)),
                ),
              ),
              policy: done(
                await step.do("policy", () => settle(runtime, precheckPolicy(workspace))),
              ),
            }
          : { ancestry };
      // Persisted as JSON, since a next action's args are open; decoded, so a replay is checked too.
      const decision = Schema.decodeUnknownSync(PrecheckDecision)(
        JSON.parse(
          await step.do("decide", async () =>
            JSON.stringify(Schema.encodeSync(PrecheckDecision)(decidePrecheck(findings))),
          ),
        ),
      );
      if (decision._tag === "Refuse") {
        const refused = await step.do("refuse", () =>
          settle(runtime, refuseSubmission(submission, decision)),
        );
        return refused._tag === "Stale"
          ? { outcome: "stale", step: "refuse", reason: refused.reason }
          : { outcome: "refused", verdictId: refused.value, reasons: decision.reasons };
      }
      const compiled = await step.do("compile", () =>
        settle(runtime, recordPlan(submission, decision)),
      );
      return compiled._tag === "Stale"
        ? { outcome: "stale", step: "compile", reason: compiled.reason }
        : { outcome: "compiled", planHash: decision.planHash };
    } finally {
      await runtime.dispose();
    }
  }
}
