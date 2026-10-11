import { Context, type Effect } from "effect";
import type { AgentNotice } from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";

export type { AgentNotice } from "../../domain/identity/index.ts";

/**
 * The piggyback: notices ride the agent's next tool result. Events reach the
 * agent's AgentSession DO through the outbox; this takes the ones no tool
 * result has carried yet.
 */
export class Notifier extends Context.Service<
  Notifier,
  {
    /**
     * Up to `limit` (at most 3) notices that no tool result has carried and no
     * inbox read has returned, oldest first, each with its cursor. Taking marks
     * them carried, so a notice rides at most one result; the inbox keeps them all.
     */
    readonly take: (agentId: AgentId, limit: number) => Effect.Effect<readonly AgentNotice[]>;
  }
>()("keel/Notifier") {}
