import { NamespaceId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec } from "./exit.ts";

/**
 * keel-verify's `buildDeps`, as keel calls it over its VERIFIER service
 * binding. keel-verify carries the same contract in its own rpc folder (rule
 * R15); keel's unit tests hold the two copies to each other.
 */

/** A sha256 as lowercase hex: an install digest, or a part's. */
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** One part of a deps bundle: its own sha256, which is its address, and its length. */
const DepsPart = Schema.Struct({
  sha256: Sha256Hex,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

/**
 * One deps build (core's `DepsNeed`, its `Locked` case, on the wire): the
 * namespace's candidate bundle at `bundleUrl`, whose install inputs are
 * `inputs` and hash to the install digest `install`.
 */
export const DepsBuildRequest = Schema.Struct({
  namespace: NamespaceId,
  need: Schema.TaggedStruct("Locked", { install: Sha256Hex, inputs: Schema.String }),
  bundleUrl: Schema.String,
});
export type DepsBuildRequest = typeof DepsBuildRequest.Type;

/**
 * A build's answer (core's `DepsAnswer`, on the wire): the parts to fetch, or
 * why there are none, as `DepsRefused` when only a change to the candidate
 * ends it and `DepsUnavailable` when a retry may.
 */
export const DepsAnswerJson = Schema.Union([
  Schema.TaggedStruct("DepsReady", { install: Sha256Hex, parts: Schema.Array(DepsPart) }),
  Schema.TaggedStruct("DepsUnavailable", { reason: Schema.String }),
  Schema.TaggedStruct("DepsRefused", { reason: Schema.String }),
  Schema.TaggedStruct("DepsUnneeded", {}),
]);
export type DepsAnswerJson = typeof DepsAnswerJson.Type;

/** A refusal is an answer, never a failure: the Exit's error side is empty, and only a defect fails it. */
export const DepsCodecs = {
  build: exitCodec(DepsAnswerJson, Schema.Never),
};
