import { CompositionRefused } from "@keeltown/core/domain/integration";
import type { NamespaceId, ProjectId } from "@keeltown/core/kernel";
import type { CandidateRequest } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  BoxComposeAnswer,
  type BoxComposeRequest,
  BoxLeaseAnswer,
  scrubbed,
} from "../../../rpc/mergebox.ts";
import type { BoxComposer } from "../gitcore/candidate-composer.ts";

/** A lease covers a box's cold start (up to three minutes) and its compose, with room. */
export const BOX_LEASE_MS = 10 * 60_000;

/**
 * How long the Lane waits on its box's answer: a cold start (up to three
 * minutes) and the slowest compose seen (six), inside the lease, so the box
 * is still held while it is waited on. Past it the box did not answer
 * (`box-failed`), and the Lane's step goes on.
 */
export const BOX_COMPOSE_MS = 8 * 60_000;

/** A namespace's BoxGate, as the client calls it. */
export interface BoxGateStub {
  readonly acquire: (ask: {
    readonly holder: string;
    readonly ttlMs: number;
    readonly waiter?: string;
  }) => Promise<unknown>;
  readonly release: (leaseId: string) => Promise<unknown>;
}

/** A project's MergeBox, as the client calls it. */
export interface MergeBoxStub {
  readonly compose: (request: BoxComposeRequest) => Promise<unknown>;
}

export interface BoxObjects {
  /** The namespace a project is placed in, whose BoxGate counts its boxes. */
  readonly namespaceOf: (projectId: ProjectId) => Effect.Effect<Option.Option<NamespaceId>>;
  readonly gate: (namespace: NamespaceId) => BoxGateStub;
  readonly box: (projectId: ProjectId) => MergeBoxStub;
}

const decodeLease = Schema.decodeUnknownEffect(BoxLeaseAnswer);
const decodeAnswer = Schema.decodeUnknownEffect(BoxComposeAnswer);

/** How much of what failed in the box a refusal carries into the evidence. */
const DETAIL_MAX = 500;

const refuse = (
  reason: string,
  paths: readonly string[] = [],
  detail?: string,
  retryAfterMs?: number,
) =>
  Effect.fail(
    new CompositionRefused({
      reason,
      paths: [...paths],
      ...(detail === undefined ? {} : { detail: scrubbed(detail).slice(0, DETAIL_MAX) }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }),
  );

/** What a box that did not answer threw, or why its answer was not one. */
const whyNot = (cause: Cause.Cause<unknown>): string => {
  const thrown = Cause.squash(cause);
  return thrown instanceof Error ? thrown.message : String(thrown);
};

/** The request a box takes for a candidate: staging, the base, and each member's workspace, base and head. */
export const boxRequest = (request: CandidateRequest): BoxComposeRequest => ({
  v: 1,
  candidateId: request.candidateId,
  staging: request.staging,
  base: request.base,
  members: request.members.map((m) => ({ repo: m.repo, base: m.base, head: m.head })),
});

/**
 * MergeBox as the Lane's composer reaches it: a lease from the project's
 * namespace's BoxGate (held by the candidate, so a retried compose renews it
 * and takes no second box), the compose in the project's box, and the lease
 * given back whatever the compose answered. What the box refuses is the
 * candidate's: a conflict git found bounces with the box's paths, and git
 * dying by a signal is `git-crashed`, asked once. What the box cannot do for
 * its own sake is infra's (`box-unavailable`, `box-failed`, `box-check`),
 * which the Lane holds and requeues, with what failed in the box as the
 * refusal's detail. A gate with no room says how long until its soonest lease
 * ends, and keeps `waiter` (the lane) to tell it when a box is freed; a gate
 * of a halted namespace is `namespace-halted`, which bounces the batch. An
 * answer is logged by its kind, never with a remote, which carries the
 * account id.
 */
export function boxComposerRpc(
  projectId: () => ProjectId,
  objects: BoxObjects,
  waiter?: () => string,
): BoxComposer {
  return {
    compose: (request) =>
      Effect.gen(function* () {
        const project = projectId();
        const namespace = yield* objects.namespaceOf(project);
        if (Option.isNone(namespace)) {
          yield* Effect.logError(
            `DEFECT mergebox ${request.candidateId}: project ${project} has no namespace, so no gate to ask`,
          );
          return yield* refuse("box-unavailable");
        }
        const gate = objects.gate(namespace.value);
        const lease = yield* Effect.tryPromise(() =>
          gate.acquire({
            holder: request.candidateId,
            ttlMs: BOX_LEASE_MS,
            ...(waiter === undefined ? {} : { waiter: waiter() }),
          }),
        ).pipe(Effect.flatMap(decodeLease), Effect.option);
        if (Option.isNone(lease)) {
          yield* Effect.logWarning(`mergebox ${request.candidateId}: the gate did not answer`);
          return yield* refuse("box-unavailable");
        }
        if (!lease.value.granted) {
          const busy = lease.value;
          if (busy.halted === true)
            return yield* refuse(
              "namespace-halted",
              [],
              `verification spend is stopped for ${namespace.value}`,
            );
          yield* Effect.logWarning(
            `mergebox ${request.candidateId}: no box, ${busy.held} of ${busy.limit} held, room in ${busy.retryAfterMs} ms`,
          );
          return yield* refuse("box-unavailable", [], undefined, busy.retryAfterMs);
        }
        const leaseId = lease.value.leaseId;
        const answer = yield* Effect.tryPromise({
          try: () => objects.box(project).compose(boxRequest(request)),
          catch: (thrown) => thrown,
        }).pipe(
          Effect.timeout(BOX_COMPOSE_MS),
          Effect.flatMap(decodeAnswer),
          Effect.exit,
          Effect.ensuring(
            Effect.promise(() => gate.release(leaseId)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `mergebox ${request.candidateId}: lease ${leaseId} kept until its deadline: ${Cause.pretty(cause)}`,
                ),
              ),
            ),
          ),
        );
        if (Exit.isFailure(answer)) {
          const why = scrubbed(whyNot(answer.cause));
          yield* Effect.logWarning(
            `mergebox ${request.candidateId}: the box did not answer: ${why}`,
          );
          return yield* refuse("box-failed", [], `the box did not answer: ${why}`);
        }
        const box = answer.value;
        switch (box.kind) {
          case "composed":
            return { trees: box.trees, scratch: box.scratch, tip: box.tip, boxCheck: box.boxCheck };
          case "refused":
            return yield* refuse("conflict", box.paths);
          case "crashed":
            yield* Effect.logError(
              `DEFECT mergebox ${request.candidateId}: git crashed, exit ${box.exitCode}`,
            );
            return yield* refuse("git-crashed");
          case "failed":
          case "unsupported":
            yield* Effect.logWarning(
              `mergebox ${request.candidateId}: ${box.kind}, ${scrubbed(box.reason)}`,
            );
            return yield* refuse("box-failed", [], `${box.kind}: ${box.reason}`);
        }
        // The box object logged the check that did not pass as a defect.
        return yield* refuse("box-check");
      }),
  };
}
