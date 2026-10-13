import { Context, type Effect } from "effect";
import type { InboxPage } from "../../domain/identity/index.ts";
import type { AgentId, RunId } from "../../domain/kernel/index.ts";

/**
 * An agent's inbox, read from its AgentSession DO (`agent:<id>`). With
 * `waitSeconds` above 0 the read long-polls: it answers as soon as a notice
 * arrives after `cursor`, or with an empty page when the wait runs out. Read
 * as `run`, it answers what is for that run or for every run, and never what
 * that run caused; with no run, what is for every run. The cursor `end` is
 * the head's: the read finds it once and waits on from it. A read that
 * answers notices counts them as read by the run; a `peek` answers the same
 * page and counts nothing, for a caller that watches and shows no notice.
 */
export class Inbox extends Context.Service<
  Inbox,
  {
    readonly read: (
      agentId: AgentId,
      cursor: string | undefined,
      waitSeconds: number,
      run?: RunId,
      peek?: boolean,
    ) => Effect.Effect<InboxPage>;
  }
>()("keel/Inbox") {}
