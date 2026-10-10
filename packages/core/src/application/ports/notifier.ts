import { Context, type Effect } from "effect";
import type { AgentId, Instant } from "../../domain/kernel/index.ts";

export interface AgentNotice {
  readonly id: string;
  readonly at: Instant;
  readonly kind: string;
  readonly title: string;
  readonly detail?: string;
  readonly ref?: string;
}

/** Delivers notices to an agent: on its next tool result, its stream, or a webhook. */
export class Notifier extends Context.Service<Notifier, {
  readonly notify: (agentId: AgentId, notice: AgentNotice) => Effect.Effect<void>;
}>()("keel/Notifier") {}
