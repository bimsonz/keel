import type { AgentId } from "@keeltown/core/kernel";
import { type StandingInput, Standings } from "@keeltown/core/ports";
import type { Principal } from "@keeltown/core/domain/identity";
import { Effect, Layer, Schema } from "effect";
import { AgentSessionCodecs, StandingCommand } from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";

/** The AgentSession DO methods `Standings` calls (`agent:<id>`), answering Exit envelopes. */
export interface StandingsStub {
  suspend(command: typeof StandingCommand.Encoded): Promise<unknown>;
  reinstate(command: typeof StandingCommand.Encoded): Promise<unknown>;
  revoke(command: typeof StandingCommand.Encoded): Promise<unknown>;
}

const encodeStanding = Schema.encodeSync(StandingCommand);

/**
 * `Standings` over each agent's AgentSession DO. The operator is the events'
 * `by`; the fingerprint hashes the move and its reason, so a retry is told
 * apart from a reused key.
 */
export function StandingsRpc(
  agentSession: (agentId: AgentId) => StandingsStub,
): Layer.Layer<Standings> {
  const move =
    (kind: "suspend" | "reinstate" | "revoke") => (principal: Principal, input: StandingInput) =>
      Effect.gen(function* () {
        const fingerprint = yield* Effect.promise(() =>
          fingerprintOf({ move: kind, reason: input.reason ?? null }),
        );
        const command = encodeStanding({
          by: `operator:${principal.agentId}`,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          idempotencyKey: input.idempotencyKey,
          fingerprint,
        });
        return yield* callObject(AgentSessionCodecs[kind], () =>
          agentSession(input.agentId)[kind](command),
        );
      });
  return Layer.succeed(
    Standings,
    Standings.of({
      suspend: move("suspend"),
      reinstate: move("reinstate"),
      revoke: move("revoke"),
    }),
  );
}
