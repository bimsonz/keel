import { Context, type Effect, Schema } from "effect";
import type { CommitSha, ContentHash, OrgId } from "../../domain/kernel/index.ts";
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
 */
export class CandidateBundles extends Context.Service<
  CandidateBundles,
  {
    readonly bundle: (
      namespace: OrgId,
      staging: RepoRef,
      commit: CommitSha,
    ) => Effect.Effect<ContentHash, BundleRefused>;
  }
>()("keel/CandidateBundles") {}
