import { Schema } from "effect";

/** A content address: `sha256:` and 64 lowercase hex digits. Bundles, plans and plugins are named by one. */
export const ContentHash = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)).pipe(
  Schema.brand("ContentHash"),
);
export type ContentHash = typeof ContentHash.Type;

/** A git object id: 40 hex digits (SHA-1) or 64 (SHA-256). */
export const CommitSha = Schema.String.check(Schema.isPattern(/^([0-9a-f]{40}|[0-9a-f]{64})$/)).pipe(
  Schema.brand("CommitSha"),
);
export type CommitSha = typeof CommitSha.Type;
