import { Context, type Effect } from "effect";
import type { AgentNotice } from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";

export type { AgentNotice } from "../../domain/identity/index.ts";

/** Delivers notices to an agent: on its next tool result, its stream, or a webhook. */
export class Notifier extends Context.Service<Notifier, {
  readonly notify: (agentId: AgentId, notice: AgentNotice) => Effect.Effect<void>;
}>()("keel/Notifier") {}
