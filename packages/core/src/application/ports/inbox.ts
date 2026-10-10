import { Context, type Effect } from "effect";
import type { InboxPage } from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";

/**
 * An agent's inbox, read from its AgentSession DO (`agent:<id>`). With
 * `waitSeconds` above 0 the read long-polls: it answers as soon as a notice
 * arrives after `cursor`, or with an empty page when the wait runs out.
 */
export class Inbox extends Context.Service<Inbox, {
  readonly read: (agentId: AgentId, cursor: string | undefined, waitSeconds: number) => Effect.Effect<InboxPage>;
}>()("keel/Inbox") {}
