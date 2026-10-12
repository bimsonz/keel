import type { AgentId } from "@keeltown/core/kernel";
import { Sessions } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { AgentSessionCodecs, OpenSession } from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";
import type { AgentSessionStub } from "./changes.ts";

const encodeOpen = Schema.encodeSync(OpenSession);

/**
 * `Sessions` over each agent's AgentSession DO. The fingerprint hashes the
 * request body, so a retry is told apart from a reused key; the DO takes the
 * session's sponsor from the agent's record. `current` reads the DO's
 * snapshot, and an agent the DO has never enrolled has no session.
 */
export function SessionsRpc(
  agentSession: (agentId: AgentId) => Pick<AgentSessionStub, "openSession" | "describe">,
): Layer.Layer<Sessions> {
  return Layer.succeed(
    Sessions,
    Sessions.of({
      open: (principal, input) =>
        Effect.gen(function* () {
          const body = {
            ...(input.harness === undefined ? {} : { harness: input.harness }),
            ...(input.model === undefined ? {} : { model: input.model }),
          };
          const fingerprint = yield* Effect.promise(() => fingerprintOf(body));
          return yield* callObject(AgentSessionCodecs.openSession, () =>
            agentSession(principal.agentId).openSession(
              encodeOpen({
                ...body,
                idempotencyKey: input.idempotencyKey,
                fingerprint,
              }),
            ),
          );
        }),
      current: (agentId) =>
        callObject(AgentSessionCodecs.describe, () => agentSession(agentId).describe()).pipe(
          Effect.map((snapshot) => snapshot.session),
          Effect.catchTag("AgentNotKnown", () => Effect.succeed(null)),
        ),
    }),
  );
}
