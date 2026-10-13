import { Context, type Effect, Schema } from "effect";
import type { PushRejected, UnexpectedHead } from "../../domain/integration/index.ts";
import type { CommitSha, Instant } from "../../domain/kernel/index.ts";
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

/**
 * The most one relayed pack may weigh: what the code host's receive-pack
 * takes in a request, with room to spare. The relay holds every pack to it,
 * and a project's whole history crosses in one pack when its staging and
 * mirror are first brought to trunk's head.
 */
export const RELAY_PACK_CAP_BYTES = 60 * 1024 * 1024;

/** What one sync did to a target: it already held trunk's head, or its main moved there. */
export type SyncOutcome = "unchanged" | "advanced";

/** The one writer of trunk. Only the Trunk DO's composition can construct it (ADR 0003). */
export class TrunkWriter extends Context.Service<
  TrunkWriter,
  {
    readonly head: Effect.Effect<CommitSha>;
    /**
     * Makes trunk's main at `commit`, a commit trunk already holds under
     * another branch (an import brings its one branch under its own name).
     * No object is sent, and the push names no old value, so a main that
     * exists is never moved: one already at `commit` is a retry and is left
     * alone, and one anywhere else is a defect.
     */
    readonly adopt: (commit: CommitSha) => Effect.Effect<void>;
    /**
     * Writes an empty trunk's first commit: a README naming the project,
     * authored and committed by Keel at `at`, and signed as every commit
     * Keel writes is. The commit is made of `name` and `at` alone, so a
     * retry writes the same one: a main that already holds it is left alone,
     * and a main at anything else is a defect. Answers the commit.
     */
    readonly seed: (name: string, at: Instant) => Effect.Effect<CommitSha>;
    /**
     * Moves trunk's main `from → to`, `from` being the WAL's old value, sent
     * explicitly whatever trunk's head reads now. `to` is a commit in staging
     * (a verified candidate), carried byte for byte. PushRejected: trunk no
     * longer held `from` (`stale`) or stayed busy (`busy`); nothing landed. A
     * pack over the receive-pack cap is PackTooLarge and lands nothing. The
     * caller reads the head back to learn the outcome.
     *
     * The pack is fetched from staging once. `admit` is run on its length in
     * bytes (the pack itself, with none of its transport framing) before
     * anything is asked of trunk, and that very pack is then sent: a failing
     * `admit` is the push's failure and lands nothing. Trunk's repo grows by
     * the length less the 32 bytes of a pack's header and trailer.
     */
    readonly push: <E>(
      from: CommitSha,
      to: CommitSha,
      admit: (packBytes: number) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, PushRejected | UnexpectedHead | PackTooLarge | E>;
    /**
     * The length in bytes of the pack `push(from, to)` relays, for a caller
     * that pushes nothing (what a stopped group was admitted, to give it
     * back): the same want and the same have, asked of staging, counted as
     * `push` counts it for `admit`. A pack over the receive-pack cap is
     * PackTooLarge, as its push would be. It reads staging and writes
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
