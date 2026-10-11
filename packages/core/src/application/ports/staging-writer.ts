import { Context, type Effect } from "effect";
import type { PushRejected } from "../../domain/integration/index.ts";
import type { CommitSha } from "../../domain/kernel/index.ts";
import type { PackTooLarge, SyncOutcome } from "./trunk-writer.ts";

/**
 * The Lane's one write outside candidate refs: staging's main follows trunk,
 * so the next batch forms on trunk's head. It reads trunk and writes staging
 * only; it never holds a token that can write trunk (ADR 0003).
 */
export class StagingWriter extends Context.Service<
  StagingWriter,
  {
    /**
     * Moves staging's main `from → to` after trunk advanced the same way,
     * relaying from trunk whatever staging lacks, with `from` as the explicit
     * old value. A staging already at `to` is `unchanged`. PushRejected
     * `stale`: staging holds neither `from` nor `to` (it moved some other
     * way); `busy`: it stayed busy. Nothing moved in either case.
     */
    readonly fastForward: (
      from: CommitSha,
      to: CommitSha,
    ) => Effect.Effect<SyncOutcome, PushRejected | PackTooLarge>;
  }
>()("keel/StagingWriter") {}
