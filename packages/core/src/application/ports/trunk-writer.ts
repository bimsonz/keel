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
    /** Pushes `from → to`; the caller reads the head back to learn the outcome. */
    readonly push: (
      from: CommitSha,
      to: CommitSha,
    ) => Effect.Effect<void, PushRejected | UnexpectedHead>;
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
