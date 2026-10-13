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
 * commits nothing new.
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
      const ancestry = done(
        await step.do("ancestry", () => settle(runtime, checkAncestry(workspace, submission))),
      );
      /**
       * A commit on its base: each of precheckReads, one durable step, then
       * its derivation, kept by `derive` and committed by `derived`. Stale
       * when the change moved on before the derivation was committed.
       */
      const descended = async (
        on: Extract<Ancestry, { readonly _tag: "Descends" }>,
      ): Promise<Settled<PrecheckFindings>> => {
        const reads = precheckReads(workspace, submission, on);
        const read = {
          ancestry: on,
          touched: done(await step.do("diff", () => settle(runtime, reads.touched))),
          policy: done(await step.do("policy", () => settle(runtime, reads.policy))),
          flow: done(await step.do("flow", () => settle(runtime, reads.flow))),
          guards: done(await step.do("guards", () => settle(runtime, reads.guards))),
        };
        // A diff that could not be read is refused by decide: with no paths, nothing derives.
        if (read.touched._tag === "Unreadable")
          return { _tag: "Done", value: { ...read, subjects: workspace.subjects } };
        const paths = read.touched.paths;
        const kept = done(
          await step.do("derive", () =>
            settle(runtime, deriveSubmission(namespace, workspace, submission, on.base, paths)),
          ),
        );
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
