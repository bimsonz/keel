import { Context, type Effect, Schema } from "effect";
import type { CommitSha, ContentHash, NamespaceId } from "../../domain/kernel/index.ts";
import type { RepoRef } from "./code-host.ts";

/** A candidate's tree holds something the bundle format cannot carry (a symlink, a submodule, an unsafe path). */
export class BundleRefused extends Schema.TaggedError<BundleRefused>()("BundleRefused", {
  reason: Schema.String,
  /** The tree entry refused, when one is: the Lane blames the member whose commit introduced it. */
  path: Schema.optional(Schema.String),
}) {}

/**
 * Bundles a composed candidate for KeelVerify: the commit's tree, read from
 * staging, written with the runner protocol's bundle writer (ustar + gzip, a
 * root manifest the sandbox checks) and stored content-addressed for the
 * namespace the project belongs to. Answers the bundle's address
 * (`sha256:<hex>`); bundling one commit twice answers the same address.
 *
 * `from` names a bundle of that namespace to take what did not change from,
 * so that a large tree is not read whole for every candidate. It only ever
 * saves reads: a commit's bundle is the same bytes with any `from` or none,
 * and one that is missing, unreadable or another tree's is no error.
 */
export class CandidateBundles extends Context.Service<
  CandidateBundles,
  {
    readonly bundle: (
      namespace: NamespaceId,
      staging: RepoRef,
      commit: CommitSha,
      from?: ContentHash,
    ) => Effect.Effect<ContentHash, BundleRefused>;
  }
>()("keel/CandidateBundles") {}
