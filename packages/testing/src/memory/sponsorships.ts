import {
  type Agent,
  type AgentCommand,
  AgentNotKnown,
  AgentStateRefused,
  decideAgent,
  eventActorOf,
  evolveAgent,
  IdempotencyConflict,
  SponsorRequestRefused,
} from "@keeltown/core/domain/identity";
import { type AgentId, Instant } from "@keeltown/core/kernel";
import { AgentDirectory, Sponsorships } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Result } from "effect";
import { nextAgentSeq } from "./standings.ts";

/** As the AgentSession DO's: how long an agent's request for a sponsor stays good. */
const ASK_MS = 10 * 60_000;

/**
 * Sponsorships over an AgentDirectory, with the AgentSession DO's rules: one
 * live request an agent, good once; the domain's Agent machine decides each
 * move on the agent as the directory holds it; the directory's sponsor (and
 * its standing, when ending the link reinstates the agent) is written with the
 * move's seq; and a key replayed with its body answers the agent as it stands.
 * `expire` is the suite's way to let a request run out.
 */
export function makeSponsorshipsMemory() {
  const asks = new Map<AgentId, { readonly code: string; readonly expiresAt: number }>();
  const byKey = new Map<string, string>();
  return {
    expire: (agentId: AgentId) =>
      Effect.sync(() => {
        const ask = asks.get(agentId);
        if (ask !== undefined) asks.set(agentId, { ...ask, expiresAt: 0 });
      }),
    layer: Layer.effect(
      Sponsorships,
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const move = (
          agentId: AgentId,
          key: string,
          body: string,
          idempotencyKey: string,
          command: AgentCommand,
          admit: (now: number) => boolean,
        ) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const found = yield* directory.findAgent(agentId);
            const replayed = byKey.get(key);
            if (replayed !== undefined) {
              if (replayed !== body) return yield* new IdempotencyConflict({ idempotencyKey });
              if (Option.isSome(found)) return found.value;
            }
            if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId });
            if (!admit(now)) return yield* new SponsorRequestRefused({ agentId });
            const decided = decideAgent(found.value, command, { now, agentId });
            if (Result.isFailure(decided)) return yield* decided.failure;
            let agent: Agent = found.value;
            for (const payload of decided.success) agent = evolveAgent(agent, { at: now, payload });
            if (decided.success.length > 0) {
              asks.delete(agentId);
              yield* directory.sponsor(agentId, agent.sponsor ?? null, nextAgentSeq());
              if (agent.state !== found.value.state)
                yield* directory.standing(agentId, { state: agent.state }, nextAgentSeq());
            }
            byKey.set(key, body);
            return agent;
          });
        return Sponsorships.of({
          ask: (agentId) =>
            Effect.gen(function* () {
              const now = yield* EffectClock.currentTimeMillis;
              const found = yield* directory.findAgent(agentId);
              if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId });
              const { state, sponsor } = found.value;
              if (state === "revoked" || sponsor !== undefined)
                return yield* new AgentStateRefused({
                  agentId,
                  state,
                  command: "Sponsor",
                  ...(state === "revoked" ? {} : { reason: "sponsor-held" as const }),
                });
              const code = crypto.randomUUID();
              const expiresAt = Instant(now + ASK_MS);
              asks.set(agentId, { code, expiresAt });
              return { code, expiresAt };
            }),
          approve: ({ agentId, by, asked, idempotencyKey }) =>
            move(
              agentId,
              `${agentId} sponsor ${idempotencyKey}`,
              JSON.stringify([by, asked]),
              idempotencyKey,
              { _tag: "Sponsor", by },
              (now) => {
                if (asked._tag === "Consent") return true;
                const ask = asks.get(agentId);
                return ask !== undefined && ask.code === asked.code && ask.expiresAt > now;
              },
            ),
          end: (actor, { agentId, idempotencyKey }) =>
            move(
              agentId,
              `${agentId} unsponsor ${idempotencyKey}`,
              JSON.stringify([eventActorOf(actor)]),
              idempotencyKey,
              { _tag: "EndSponsorship", by: eventActorOf(actor) },
              () => true,
            ).pipe(Effect.catchTag("SponsorRequestRefused", (refusal) => Effect.die(refusal))),
        });
      }),
    ),
  };
}
