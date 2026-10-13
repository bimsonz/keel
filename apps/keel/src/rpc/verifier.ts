import { ProbeOutcome, VerifierUnavailable, World } from "@keeltown/core/domain/verification";
import { ContentHash, NamespaceId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec } from "./exit.ts";

/**
 * keel-verify's entrypoint, as keel calls it over its VERIFIER service
 * binding. keel-verify carries the same contract in its own rpc folder (rule
 * R15); keel's unit tests decode replies its codec encodes, so the copies
 * cannot drift apart.
 */

/** One Tier 1 probe run (the ProbeRunner port's request): a namespace's probe bundle against one of its world bundles. */
export const ProbeRunRequest = Schema.Struct({
  namespace: NamespaceId,
  probe: ContentHash,
  world: World,
  worldBundle: ContentHash,
  run: Schema.Int,
});

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

/** The question asked before any probe is drafted: could one run against this world bundle of the namespace's? */
export const WorldReadyRequest = Schema.Struct({
  namespace: NamespaceId,
  worldBundle: ContentHash,
});

/** Ready, or why every run against the world would be refused as the namespace's store stands. */
export const WorldReadiness = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ready") }),
  Schema.Struct({ _tag: Schema.Literal("Unready"), reason: Schema.String }),
]);

export const VerifierCodecs = {
  runProbe: exitCodec(ProbeRunReply, VerifierUnavailable),
  worldReady: exitCodec(WorldReadiness, VerifierUnavailable),
};

/**
 * keel-verify's default export, as far as keel calls it: `runProbe` routes a
 * run to the VerifierDO for its (probe, world), `worldReady` answers from
 * the bundle store whether a probe could run against a world at all, and
 * `buildDeps` routes a deps build to the deps box for its (namespace, install
 * digest).
 */
export interface VerifierEntrypoint {
  /** Answers the run's Exit as JSON (`VerifierCodecs.runProbe`), which the caller decodes. */
  runProbe(request: unknown): Promise<unknown>;
  /** Answers the readiness's Exit as JSON (`VerifierCodecs.worldReady`), which the caller decodes. */
  worldReady(request: unknown): Promise<unknown>;
  /** Answers the build's Exit as JSON (`DepsCodecs.build`), which the caller decodes. */
  buildDeps(request: unknown): Promise<unknown>;
}
