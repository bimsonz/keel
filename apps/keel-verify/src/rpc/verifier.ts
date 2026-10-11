import { ProbeOutcome, VerifierUnavailable, World } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/** What a VerifierDO reports when a job ends: every step's result, as runner-protocol `StepFinished` messages. */
export const JobReport = Schema.Struct({
  jobId: Schema.NonEmptyString,
  outcome: Schema.Literals(["completed", "infra-failure", "budget-exhausted"]),
  steps: Schema.Array(Schema.Unknown),
});

/** One Tier 1 probe run (the ProbeRunner port's request): the probe's bundle against one world's bundle. */
export const ProbeRunRequest = Schema.Struct({
  probe: ContentHash,
  world: World,
  worldBundle: ContentHash,
  run: Schema.Int,
});
export type ProbeRunRequest = typeof ProbeRunRequest.Type;

/** What the probe reported, read against the exit-code and JSON-line contract; a harness error is never a cell. */
export const ProbeRunJson = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ran"),
    outcome: ProbeOutcome,
    reason: Schema.String,
    observations: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("harness-error"),
    reason: Schema.String,
    observations: Schema.Array(Schema.String),
  }),
]);

/** A run's answer, with whether it waited for one of the DO's slots and which isolate ran it. */
export const ProbeRunReply = Schema.Struct({
  run: ProbeRunJson,
  queued: Schema.Boolean,
  instance: Schema.optional(Schema.String),
});
export type ProbeRunReply = typeof ProbeRunReply.Type;

export const VerifierCodecs = {
  run: exitCodec(JobReport, VerifierUnavailable),
  runProbe: exitCodec(ProbeRunReply, VerifierUnavailable),
};

/** The VerifierDO for a run: one per (probe, world), so a matrix's worlds fan out across DOs, one CPU each. */
export const verifierName = (request: ProbeRunRequest): string =>
  `probe:${request.probe.slice("sha256:".length)}:${request.worldBundle.slice("sha256:".length)}`;

/**
 * A VerifierDO in keel-verify: one per (probe, world), running throwaway
 * isolates with no outbound network. keel-verify holds no credentials, so
 * nothing it runs can reach any.
 *
 * - `run(job)` takes a runner-protocol `JobSubmitted`, encoded.
 * - `runProbe(request)` takes a `ProbeRunRequest`, encoded, and answers
 *   `ProbeRunReply`, or `VerifierUnavailable` when it could not run the probe
 *   at all (a bundle missing or not matching its hash, no deps bundle for the
 *   world's lockfile, a bundler that would install).
 */
export interface VerifierRpc {
  run(job: unknown): Promise<ExitJson>;
  runProbe(request: unknown): Promise<ExitJson>;
}
