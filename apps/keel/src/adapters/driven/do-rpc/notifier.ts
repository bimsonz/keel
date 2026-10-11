import type { AgentId } from "@keeltown/core/kernel";
import { Notifier } from "@keeltown/core/ports";
import { Layer } from "effect";
import { AgentSessionCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";
import type { AgentSessionStub } from "./changes.ts";

/**
 * `Notifier` over the agent's AgentSession DO, which marks what it hands out
 * as carried in the same commit. A notice taken by a call whose answer is then
 * lost does not ride again; the inbox still holds it.
 */
export function NotifierRpc(
  agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "takeNotices">,
): Layer.Layer<Notifier> {
  return Layer.succeed(
    Notifier,
    Notifier.of({
      take: (agentId, limit) =>
        callObject(AgentSessionCodecs.takeNotices, () =>
          agentSession(agentId).takeNotices({ limit }),
        ),
    }),
  );
}
