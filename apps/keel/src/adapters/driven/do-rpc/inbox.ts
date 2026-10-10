import type { AgentId } from "@keeltown/core/kernel";
import { Inbox } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { AgentSessionCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";
import type { AgentSessionStub } from "./changes.ts";

/**
 * `Inbox` over the agent's AgentSession DO, whose waiter holds the read until
 * a notice arrives or the deadline passes.
 *
 * The caller's token was verified against the AgentDirectory, a projection of
 * the AgentSession DOs, and enrolment commits to the DO first. A DO that does
 * not know an authenticated agent is therefore a broken invariant: a defect,
 * logged and answered 500, never an empty inbox.
 */
export function InboxRpc(
  agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "inbox">,
): Layer.Layer<Inbox> {
  return Layer.succeed(
    Inbox,
    Inbox.of({
      read: (agentId, cursor, waitSeconds) =>
        callObject(AgentSessionCodecs.inbox, () =>
          agentSession(agentId).inbox({
            ...(cursor === undefined ? {} : { cursor }),
            waitMs: waitSeconds * 1000,
          }),
        ).pipe(
          Effect.catchTag("AgentNotKnown", (error) =>
            Effect.die(
              new Error(
                `Agent ${error.agentId} holds a valid token, but its AgentSession does not know it: the directory and the DO disagree`,
              ),
            ),
          ),
        ),
    }),
  );
}
