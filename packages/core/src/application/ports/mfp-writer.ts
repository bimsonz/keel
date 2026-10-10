import { Context, type Effect } from "effect";
import type { CommitSha } from "../../domain/kernel/index.ts";

/** An MFP record, already validated against the published schema. */
export type MfpRecord = Readonly<Record<string, unknown>> & { readonly mfp: "0.1"; readonly kind: string; readonly id: string };

/** Writes MFP claims: the record store, commit trailers and `refs/notes/mfp`. */
export class MfpWriter extends Context.Service<MfpWriter, {
  readonly write: (records: readonly MfpRecord[]) => Effect.Effect<void>;
  readonly note: (commit: CommitSha, records: readonly MfpRecord[]) => Effect.Effect<void>;
}>()("keel/MfpWriter") {}
