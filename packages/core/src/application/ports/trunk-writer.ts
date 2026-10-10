import { Context, type Effect } from "effect";
import type { PushRejected, UnexpectedHead } from "../../domain/integration/index.ts";
import type { CommitSha } from "../../domain/kernel/index.ts";

/** The one writer of trunk. Only the Trunk DO's composition can construct it (ADR 0003). */
export class TrunkWriter extends Context.Service<TrunkWriter, {
  readonly head: Effect.Effect<CommitSha>;
  /** Pushes `from → to`; the caller reads the head back to learn the outcome. */
  readonly push: (from: CommitSha, to: CommitSha) => Effect.Effect<void, PushRejected | UnexpectedHead>;
}>()("keel/TrunkWriter") {}
