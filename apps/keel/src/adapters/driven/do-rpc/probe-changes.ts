import { projectRepos } from "@keeltown/core/application/integration";
import { planStateOf, submissionStateOf } from "@keeltown/core/application/verification";
import type { ChangeNotFound } from "@keeltown/core/domain/coordination";
import type { ChangeId } from "@keeltown/core/kernel";
import { CodeHost, type PartyAnswer, type PlanAnswer, ProbeChanges } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  AwaitPlanCommand,
  AwaitSubmissionCommand,
  ChangeCodecs,
  type ChangeRpc,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Change DO methods `ProbeChanges` calls (`change:<ULID>`), answering Exit envelopes. */
export type ProbeChangeStub = Pick<ChangeRpc, "awaitPlan" | "awaitSubmission" | "workspace">;

/** How many times a party is read again when its workspace went away between two reads: it landed or left. */
const READS = 3;

/**
 * ProbeChanges over the Change DO's RPC: each change through the Change
 * contract, never its storage. The answer is classified by core's
 * `submissionStateOf`: a submitted change's world is in its workspace (read from
 * `workspace()`), and a landed one's is its landing commit in staging, over
 * that commit's first parent. Its plan is a separate read (`awaitPlan`),
 * classified by core's `planStateOf`, made by the world check that runs it. A
 * change the DO answered that core reads as still waiting (no current
 * submission, or a plan still to come) is a defect: the DO recorded no
 * subscriber, so a wait for it would never end.
 */
export function ProbeChangesRpc(
  change: (changeId: ChangeId) => ProbeChangeStub,
): Layer.Layer<ProbeChanges, never, CodeHost> {
  return Layer.effect(
    ProbeChanges,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      const read = (
        changeId: ChangeId,
        subscriber: string,
        left: number,
      ): Effect.Effect<PartyAnswer, ChangeNotFound> =>
        Effect.gen(function* () {
          const stub = change(changeId);
          const answer = yield* callObject(ChangeCodecs.awaitSubmission, () =>
            stub.awaitSubmission(Schema.encodeSync(AwaitSubmissionCommand)({ subscriber })),
          );
          if ("waiting" in answer) return { _tag: "Waiting" } satisfies PartyAnswer;
          const submission = submissionStateOf(answer.change);
          if (submission._tag === "Gone")
            return { _tag: "Gone", state: submission.state } satisfies PartyAnswer;
          if (submission._tag === "Unsubmitted")
            return yield* Effect.die(
              new Error(
                `${changeId} is ${answer.change.state} with no current submission, but awaitSubmission answered it without a wait`,
              ),
            );
          if (submission._tag === "Landed") {
            const staging = projectRepos(answer.projectId).staging;
            const landing = yield* host.readCommit(staging, submission.landing).pipe(Effect.orDie);
            const parent = landing.parents[0];
            if (parent === undefined)
              return yield* Effect.die(new Error(`${submission.landing} has no parent on trunk`));
            return {
              _tag: "Landed",
              landing: submission.landing,
              parent,
            } satisfies PartyAnswer;
          }
          const workspace = yield* callObject(ChangeCodecs.workspace, () => stub.workspace()).pipe(
            Effect.map((w) => w.repo),
            Effect.catchTag("ChangeStateRefused", () => Effect.succeed(undefined)),
          );
          // The workspace went with the change between the two reads: read the change again.
          if (workspace === undefined)
            return left > 1
              ? yield* read(changeId, subscriber, left - 1)
              : yield* Effect.die(
                  new Error(`${changeId} kept losing its workspace under the read`),
                );
          return {
            _tag: "Submitted",
            repo: workspace,
            head: submission.head,
            base: submission.base,
          } satisfies PartyAnswer;
        });
      return ProbeChanges.of({
        awaitSubmission: (changeId, subscriber) => read(changeId, subscriber, READS),
        awaitPlan: (changeId, subscriber) =>
          Effect.gen(function* () {
            const answer = yield* callObject(ChangeCodecs.awaitPlan, () =>
              change(changeId).awaitPlan(Schema.encodeSync(AwaitPlanCommand)({ subscriber })),
            );
            if ("waiting" in answer) return { _tag: "Waiting" } satisfies PlanAnswer;
            const plan = planStateOf(answer.change);
            if (plan._tag === "Pending")
              return yield* Effect.die(
                new Error(
                  `${changeId} is ${answer.change.state} with its plan still to come, but awaitPlan answered it without a wait`,
                ),
              );
            return plan;
          }),
      });
    }),
  );
}
