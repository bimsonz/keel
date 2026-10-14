import { Context, type Effect, Schema } from "effect";
import type { PushRejected, UnexpectedHead } from "../../domain/integration/index.ts";
import type { CommitSha, Instant } from "../../domain/kernel/index.ts";
import type { RepoNotFound, RepoRef } from "./code-host.ts";
import type { UpstreamUnreachable } from "./trunks.ts";

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

/** What `take` brought: trunk's head, and the pack that carried it there when this take sent one. */
export interface TakenTrunk {
  readonly head: CommitSha;
  readonly bytes?: number;
}

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
     * Brings an empty trunk the whole history of `source`'s main and makes
     * trunk's main at its head, relaying the source's own pack so commit ids
     * survive: how a forked project's trunk starts. Answers the commit, and
     * the length of the pack it sent, which is what `historyBytes` weighs at
     * that commit: the same want and no have. The pack is fetched once and
     * sent with no old value, so a main that exists is never moved: a trunk
     * that has one is a retry, and its main is answered as it is, whatever
     * the source's has moved to since, with no `bytes`, since nothing was
     * sent. A source that is gone is RepoNotFound. A history over the
     * receive-pack cap is PackTooLarge with nothing sent, and its `bytes` are
     * what had been read when the read stopped, not what the history weighs.
     */
    readonly take: (source: RepoRef) => Effect.Effect<TakenTrunk, RepoNotFound | PackTooLarge>;
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
    /**
     * The head of `upstream`'s branch `ref`, as its own advertisement names
     * it, asked with no credential: none when the branch is gone. An upstream
     * that answers nothing Keel can read is UpstreamUnreachable.
     */
    readonly upstreamHead: (upstream: {
      readonly url: string;
      readonly ref: string;
    }) => Effect.Effect<CommitSha | undefined, UpstreamUnreachable>;
    /**
     * Brings into trunk what `to` reaches in `upstream` past `haves`, under
     * trunk's side ref `refs/keel/upstream` and never its main, so an
     * ancestry walk can read it there. Answers the pack's length, as `push`
     * weighs one for `admit`: the repo grows by that less the pack's header
     * and trailer. A pack over the receive-pack cap is PackTooLarge with
     * nothing sent. Idempotent: the side ref is set to `to` whatever it held.
     */
    readonly fetchUpstream: (
      upstream: { readonly url: string; readonly ref: string },
      to: CommitSha,
      haves: readonly CommitSha[],
    ) => Effect.Effect<number, PackTooLarge | UpstreamUnreachable>;
    /**
     * Moves trunk's main `from → to` in one push, `from` sent as the explicit
     * old value: `to` must already be in trunk (`fetchUpstream`), so no
     * object is sent, and the side ref is left for `dropUpstream`. PushRejected:
     * trunk no longer held `from` (`stale`) or stayed busy (`busy`), and
     * nothing moved. The caller reads the head back to learn the outcome.
     */
    readonly fastForward: (from: CommitSha, to: CommitSha) => Effect.Effect<void, PushRejected>;
    /**
     * Whether `to` descends from `from` (or is it) in trunk's repo, as `git
     * merge-base --is-ancestor` answers, reading what `fetchUpstream` brought
     * in. The walk does not go past `stopAt`, and it fails closed: one that
     * would read more commits than a walk may answers false.
     */
    readonly descends: (
      from: CommitSha,
      to: CommitSha,
      stopAt: readonly CommitSha[],
    ) => Effect.Effect<boolean>;
    /** Deletes trunk's side ref, as a sync that moved nothing leaves it. Idempotent. */
    readonly dropUpstream: Effect.Effect<void>;
  }
>()("keel/TrunkWriter") {}
