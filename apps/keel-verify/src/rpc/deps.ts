import { NamespaceId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

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
 * `inputs` and hash to the install digest `install`. A candidate with no
 * lockfile is never sent here.
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

/** Who a deps box is building for, while it builds. */
export const DepsBuilding = Schema.Struct({ namespace: NamespaceId, install: Sha256Hex });
export type DepsBuilding = typeof DepsBuilding.Type;

/** A refusal is an answer, never a failure: the Exit's error side is empty, and only a defect fails it. */
export const DepsCodecs = {
  build: exitCodec(DepsAnswerJson, Schema.Never),
};

/**
 * The KeelDepsBox for a build: one per (namespace, install digest). That is
 * the single-flight: every caller with the same two reaches the same object,
 * and no two namespaces ever share one, whatever they install.
 */
export const depsBoxName = (request: DepsBuildRequest): string =>
  `deps:${request.namespace}:${request.need.install}`;

/**
 * A KeelDepsBox in keel-verify: one per (namespace, install digest), with a
 * container that reaches the public registry and Keel's own hosts and
 * nothing else. It holds no credential.
 *
 * - `build(request)` takes a `DepsBuildRequest`, encoded, and answers
 *   `DepsCodecs.build`: `DepsReady` from the pointer already kept or from a
 *   build it ran or joined, and otherwise `DepsRefused` or `DepsUnavailable`
 *   with the reason, as core's `depsRefusal` reads the box's refusal.
 * - `building()` answers who the box is building for, and null when no build
 *   is in flight. Only the box's own upload handler asks.
 */
export interface DepsBoxRpc {
  build(request: unknown): Promise<ExitJson>;
  building(): Promise<DepsBuilding | null>;
}
