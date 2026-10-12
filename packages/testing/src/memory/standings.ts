import {
  actorId,
  type Agent,
  AgentNotKnown,
  decideAgent,
  evolveAgent,
  IdempotencyConflict,
} from "@keeltown/core/domain/identity";
import { type AgentId, Instant } from "@keeltown/core/kernel";
import { AgentDirectory, type StandingInput, Standings } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Result } from "effect";

type Move = "suspend" | "reinstate" | "revoke";

/**
 * Standings over an AgentDirectory, with the AgentSession DO's rules: the
 * domain's Agent machine decides each move on the agent as the directory holds
 * it, the directory's standing is written with the move's seq, and a key
 * replayed with its body answers the agent as it stands.
 */
export function makeStandingsMemory() {
  const byKey = new Map<string, string>();
  const seqs = new Map<AgentId, number>();
  return {
    layer: Layer.effect(
      Standings,
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const move = (by: string, input: StandingInput, kind: Move) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const key = `${input.agentId} ${input.idempotencyKey}`;
            const body = JSON.stringify([kind, input.reason ?? null]);
            const found = yield* directory.findAgent(input.agentId);
            const replayed = byKey.get(key);
            if (replayed !== undefined) {
              if (replayed !== body)
                return yield* new IdempotencyConflict({ idempotencyKey: input.idempotencyKey });
              if (Option.isSome(found)) return found.value;
            }
            if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId: input.agentId });
            const decided = decideAgent(
              found.value,
              kind === "suspend"
                ? { _tag: "Suspend", reason: input.reason ?? "", by }
                : kind === "reinstate"
                  ? { _tag: "Reinstate", by }
                  : { _tag: "Revoke", by },
              { now, agentId: input.agentId },
            );
            if (Result.isFailure(decided)) return yield* decided.failure;
            let agent: Agent = found.value;
            for (const payload of decided.success) agent = evolveAgent(agent, { at: now, payload });
            const seq = (seqs.get(input.agentId) ?? 1) + 1;
            seqs.set(input.agentId, seq);
            yield* directory.standing(
              input.agentId,
              { state: agent.state, revocationEpoch: agent.revocationEpoch },
              seq,
            );
            byKey.set(key, body);
            return agent;
          });
        return Standings.of({
          suspend: (actor, input) => move(`operator:${actorId(actor)}`, input, "suspend"),
          reinstate: (actor, input) => move(`operator:${actorId(actor)}`, input, "reinstate"),
          revoke: (actor, input) => move(`operator:${actorId(actor)}`, input, "revoke"),
        });
      }),
    ),
  };
}
