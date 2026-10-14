import { Context, type Effect } from "effect";
import type { CommitSha } from "../../domain/kernel/index.ts";
import type { KeelRecord } from "../../domain/memory/index.ts";

/** Keel's record of an MFP 0.2 message, as the writer stores it. */
export type MfpRecord = KeelRecord;

/** Writes MFP claims: the record store, commit trailers and `refs/notes/mfp`. */
export class MfpWriter extends Context.Service<
  MfpWriter,
  {
    readonly write: (records: readonly MfpRecord[]) => Effect.Effect<void>;
    readonly note: (commit: CommitSha, records: readonly MfpRecord[]) => Effect.Effect<void>;
  }
>()("keel/MfpWriter") {}
