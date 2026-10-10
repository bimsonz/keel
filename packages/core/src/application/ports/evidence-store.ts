import { Context, type Effect, Schema } from "effect";
import { ContentHash, type Json } from "../../domain/kernel/index.ts";

/** Nothing is stored under this hash. */
export class EvidenceMissing extends Schema.TaggedError<EvidenceMissing>()("EvidenceMissing", {
  hash: ContentHash,
}) {}

/**
 * Step evidence and redacted logs, as JSON documents addressed by
 * `contentHashOf` (the hash of their canonical JSON). Kept apart from
 * BundleStore on purpose: a sandbox can fetch bundles by hash, so one
 * candidate's evidence must never sit where another candidate's sandbox can
 * reach it. Callers redact before they put.
 */
export class EvidenceStore extends Context.Service<
  EvidenceStore,
  {
    readonly put: (document: Json) => Effect.Effect<ContentHash>;
    readonly get: (hash: ContentHash) => Effect.Effect<Json, EvidenceMissing>;
  }
>()("keel/EvidenceStore") {}
