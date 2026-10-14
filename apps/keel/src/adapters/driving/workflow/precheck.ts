import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type Ancestry,
  checkAncestry,
  commitDerivation,
  decidePrecheck,
  deriveSubmission,
  planSubjects,
  PrecheckDecision,
  type PrecheckFindings,
  type PrecheckSubmission,
  precheckReads,
  recordPlan,
  refuseSubmission,
  refuseUnplaced,
  startPrecheck,
} from "@keeltown/core/application/verification";
import { ChangeId, CommitSha } from "@keeltown/core/kernel";
import { Cause, type Effect, Exit, type ManagedRuntime, Option, Schema } from "effect";
import { precheckRuntime } from "../../../composition/workflow.ts";
import { claimedInput } from "./pooled.ts";
import { placedStep } from "./steps.ts";

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
  | { readonly outcome: "stale"; readonly step: string; readonly reason: string }
  /** A warm instance whose claim never came: it ran nothing and wrote nothing. */
  | { readonly outcome: "retired" };

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
const settledValue = <A>(settled: Settled<A>): A => {
  if (settled._tag === "Stale") throw new Error(`unexpected stale step: ${settled.reason}`);
  return settled.value;
};

/**
 * Precheck, started by `ChangeSubmitted` as `precheck-<eventId>`: refuse a
 * submitted commit that does not descend from the submission's base; diff
 * one that does against that base, refuse guard and protected paths, read the
 * base's flow and the project's admitted guards, and compile the Verification
 * Plan under them for the subjects the change declared and those its code
 * was derived to affect, refusing any step KeelVerify cannot run. Steps:
 * `start`, `namespace` (the namespace the project belongs to, under which the
 * derivation and the plan are kept; a project with no place is refused there,
 * through `refuse`, since nothing of it can be kept), `ancestry`, then for a commit on its base `diff`, `policy`, `flow`,
 * `guards`, `derive` (which keeps the derivation record and answers only its
 * hash and subjects) and `derived` (which commits what was kept), `decide`,
 * then `refuse` or `compile` (which stores the plan before recording it).
 * Nothing derives for a commit off its base, or one whose diff could not be
 * read. Each write is idempotent by this instance's id, so a replayed step
 * commits nothing new. A warm instance (`precheck-pool-…`, started by its
 * pool) first waits for its claim, whose payload is the event's params, and
 * retires having written nothing when no claim comes.
 */
export class Precheck extends WorkflowEntrypoint<Env, PrecheckParams> {
  override async run(
    event: WorkflowEvent<PrecheckParams>,
    step: WorkflowStep,
  ): Promise<PrecheckOutcome> {
    const input = await claimedInput(event, step);
    if (input._tag === "Retired") return { outcome: "retired" };
    const params = Schema.decodeUnknownOption(PrecheckParams)(input.payload);
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
      const refuse = async (
        decision: Extract<PrecheckDecision, { readonly _tag: "Refuse" }>,
      ): Promise<PrecheckOutcome> => {
        const refused = await step.do("refuse", () =>
          settle(runtime, refuseSubmission(submission, decision)),
        );
        return refused._tag === "Stale"
          ? { outcome: "stale", step: "refuse", reason: refused.reason }
          : { outcome: "refused", verdictId: refused.value, reasons: decision.reasons };
      };
      const namespace = await placedStep(
        step,
        (effect) => runtime.runPromise(effect),
        workspace.projectId,
      );
      if (namespace === undefined) return await refuse(refuseUnplaced(workspace.projectId));
      const ancestry = settledValue(
        await step.do("ancestry", () => settle(runtime, checkAncestry(workspace, submission))),
      );
      /**
       * A commit on its base: the four reads of precheckReads, each one
       * durable step, run at once, and its derivation, kept by `derive` as
       * soon as `diff` has the paths, and committed by `derived` once every
       * read is in. Each step keeps its fixed name, so a replay finds it
       * whatever order they finished in. Stale when the change moved on
       * before the derivation was committed.
       */
      const descended = async (
        on: Extract<Ancestry, { readonly _tag: "Descends" }>,
      ): Promise<Settled<PrecheckFindings>> => {
        const reads = precheckReads(workspace, submission, on);
        const touched = step.do("diff", () => settle(runtime, reads.touched)).then(settledValue);
        // A diff that could not be read is refused by decide: with no paths, nothing derives.
        const keeping = touched.then((diff) =>
          diff._tag === "Unreadable"
            ? undefined
            : step
                .do("derive", () =>
                  settle(
                    runtime,
                    deriveSubmission(namespace, workspace, submission, on.base, diff.paths),
                  ),
                )
                .then(settledValue),
        );
        const steps = [
          touched,
          step.do("policy", () => settle(runtime, reads.policy)).then(settledValue),
          step.do("flow", () => settle(runtime, reads.flow)).then(settledValue),
          step.do("guards", () => settle(runtime, reads.guards)).then(settledValue),
          keeping,
        ] as const;
        // Every step settles before a failure is thrown, so none is still running when the run
        // ends and disposes its runtime; Promise.all then throws the first failure in this order.
        await Promise.allSettled(steps);
        const [diff, policy, flow, guards, kept] = await Promise.all(steps);
        const read = { ancestry: on, touched: diff, policy, flow, guards };
        if (kept === undefined)
          return { _tag: "Done", value: { ...read, subjects: workspace.subjects } };
        const derived = await step.do("derived", () =>
          settle(runtime, commitDerivation(namespace, submission, kept.derivationRef)),
        );
        if (derived._tag === "Stale") return derived;
        return {
          _tag: "Done",
          value: { ...read, subjects: planSubjects(workspace.subjects, kept.subjects) },
        };
      };
      const found: Settled<PrecheckFindings> =
        ancestry._tag === "Descends"
          ? await descended(ancestry)
          : { _tag: "Done", value: { ancestry } };
      if (found._tag === "Stale")
        return { outcome: "stale", step: "derived", reason: found.reason };
      const findings = found.value;
      // Persisted as JSON, since a next action's args are open; decoded, so a replay is checked too.
      const decision = Schema.decodeUnknownSync(PrecheckDecision)(
        JSON.parse(
          await step.do("decide", async () =>
            JSON.stringify(Schema.encodeSync(PrecheckDecision)(decidePrecheck(findings))),
          ),
        ),
      );
      if (decision._tag === "Refuse") return await refuse(decision);
      const compiled = await step.do("compile", () =>
        settle(runtime, recordPlan(namespace, submission, decision)),
      );
      return compiled._tag === "Stale"
        ? { outcome: "stale", step: "compile", reason: compiled.reason }
        : { outcome: "compiled", planHash: decision.planHash };
    } finally {
      await runtime.dispose();
    }
  }
}
