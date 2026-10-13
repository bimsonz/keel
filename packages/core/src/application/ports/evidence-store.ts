import { Context, type Effect, Schema } from "effect";
import { ContentHash, type Json, type NamespaceId } from "../../domain/kernel/index.ts";

/** Nothing is stored under this hash. */
export class EvidenceMissing extends Schema.TaggedError<EvidenceMissing>()("EvidenceMissing", {
  hash: ContentHash,
}) {}

/**
 * Step evidence and redacted logs, as JSON documents addressed by
 * `contentHashOf` (the hash of their canonical JSON). Kept apart from
 * BundleStore on purpose: a sandbox can fetch bundles by hash, so one
 * candidate's evidence must never sit where another candidate's sandbox can
 * reach it. Callers redact before they put. Each document is kept for one
 * namespace, and is missing for every other.
 */
export class EvidenceStore extends Context.Service<
  EvidenceStore,
  {
    readonly put: (namespace: NamespaceId, document: Json) => Effect.Effect<ContentHash>;
    readonly get: (
      namespace: NamespaceId,
      hash: ContentHash,
    ) => Effect.Effect<Json, EvidenceMissing>;
  }
>()("keel/EvidenceStore") {}
