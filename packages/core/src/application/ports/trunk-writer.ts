import { Context, type Effect, Schema } from "effect";
import type { PushRejected, UnexpectedHead } from "../../domain/integration/index.ts";
import type { CommitSha } from "../../domain/kernel/index.ts";
import type { RepoNotFound, RepoRef } from "./code-host.ts";

/**
 * A relayed pack over the code host's receive-pack cap (about 64 MiB per
 * request). A known limit until relayed packs are split: the sync fails
 * loudly instead of pushing part of trunk.
 */
export class PackTooLarge extends Schema.TaggedError<PackTooLarge>()("PackTooLarge", {
  repo: Schema.Struct({ namespace: Schema.String, name: Schema.String }),
  bytes: Schema.Number,
  limit: Schema.Number,
}) {}

/** What one sync did to a target: it already held trunk's head, or its main moved there. */
export type SyncOutcome = "unchanged" | "advanced";

/** The one writer of trunk. Only the Trunk DO's composition can construct it (ADR 0003). */
export class TrunkWriter extends Context.Service<
  TrunkWriter,
  {
    readonly head: Effect.Effect<CommitSha>;
    /**
     * Moves trunk's main `from → to`, `from` being the WAL's old value, sent
     * explicitly whatever trunk's head reads now. `to` is a commit in staging
     * (a verified candidate), carried byte for byte. PushRejected: trunk no
     * longer held `from` (`stale`) or stayed busy (`busy`); nothing landed. A
     * pack over the receive-pack cap is PackTooLarge and lands nothing. The
     * caller reads the head back to learn the outcome.
     */
    readonly push: (
      from: CommitSha,
      to: CommitSha,
    ) => Effect.Effect<void, PushRejected | UnexpectedHead | PackTooLarge>;
    /**
     * The length in bytes of the pack `push(from, to)` relays: the same want
     * and the same have, asked of staging, counted as the pack itself with
     * none of its transport framing. Trunk's repo grows by that less the 32
     * bytes of a pack's header and trailer. A pack over the receive-pack cap
     * is PackTooLarge, as its push would be. It reads staging and writes
     * nothing.
     */
    readonly packBytes: (from: CommitSha, to: CommitSha) => Effect.Effect<number, PackTooLarge>;
    /**
     * The length in bytes of the pack that carries everything `at` reaches
     * in trunk: what the repo held when it was created at `at`, and what a
     * fork of it takes in. Counted as it streams, so a history of any size
     * is weighed without being held. It reads trunk and writes nothing.
     */
    readonly historyBytes: (at: CommitSha) => Effect.Effect<number>;
    /**
     * Copies trunk's head into each target's main (staging, the mirror),
     * relaying trunk's own pack so commit ids survive. Idempotent: a target
     * already at the head is left alone, and one that moves meanwhile is read
     * again and relayed again. Answers the head it copied, read once.
     */
    readonly sync: (
      targets: readonly RepoRef[],
    ) => Effect.Effect<
      { readonly head: CommitSha; readonly outcomes: readonly SyncOutcome[] },
      RepoNotFound | PackTooLarge
    >;
  }
>()("keel/TrunkWriter") {}
