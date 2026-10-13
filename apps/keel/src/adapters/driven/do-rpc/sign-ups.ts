import type { AgentId } from "@keeltown/core/kernel";
import { AgentSignUps } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { AgentSessionCodecs, SignUpCommand } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";
import type { AgentSessionStub } from "./changes.ts";

const encodeSignUp = Schema.encodeSync(SignUpCommand);

/**
 * `AgentSignUps` over the agent's own AgentSession DO, the agents' source of
 * truth. The agent id is made from the key, so the same key always reaches the
 * same object, which is what makes signing up twice one account.
 */
export function AgentSignUpsRpc(
  agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "signUp">,
): Layer.Layer<AgentSignUps> {
  return Layer.succeed(
    AgentSignUps,
    AgentSignUps.of({
      signUp: ({ agentId, handle, key, name }) =>
        callObject(AgentSessionCodecs.signUp, () =>
          agentSession(agentId).signUp(encodeSignUp({ handle, key, name })),
        ),
    }),
  );
}
