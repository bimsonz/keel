import { Schema } from "effect";
import { CommitSha } from "./hash.ts";
import { SessionId } from "./ids.ts";

/** A code symbol pinned to a commit. */
export const Anchor = Schema.Struct({
  path: Schema.NonEmptyString,
  symbol: Schema.optional(Schema.String),
  commit: CommitSha,
});
export type Anchor = typeof Anchor.Type;

/** What a claim rests on: a numbered session message, a code anchor, or an MFP record. */
export const Citation = Schema.Union([
  Schema.TaggedStruct("message", { session: SessionId, seq: Schema.Int }),
  Schema.TaggedStruct("anchor", { anchor: Anchor }),
  Schema.TaggedStruct("record", { id: Schema.NonEmptyString }),
]);
export type Citation = typeof Citation.Type;
