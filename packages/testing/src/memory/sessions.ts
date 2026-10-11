import {
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
  SessionSponsorRefused,
} from "@keeltown/core/domain/identity";
import type { Session } from "@keeltown/core/domain/memory";
import { type AgentId, Instant, makeId } from "@keeltown/core/kernel";
import { AgentDirectory, Sessions } from "@keeltown/core/ports";
import { Effect, Layer, Option } from "effect";
import { ulidOf } from "./operator.ts";

/**
 * Sessions over an AgentDirectory, with the AgentSession DO's rules: the agent
 * must be known and active, the session acts for the token's sponsor else the
 * enrolment's, and a key replayed with its body answers its session.
 */
export function makeSessionsMemory() {
  const current = new Map<AgentId, Session>();
  const byKey = new Map<string, { readonly session: Session; readonly fingerprint: string }>();
  let count = 0;
  return {
    current,
    layer: Layer.effect(
      Sessions,
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        return Sessions.of({
          open: (principal, input) =>
            Effect.gen(function* () {
              const agentId = principal.agentId;
              const found = yield* directory.findAgent(agentId);
              if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId });
              const key = `${agentId}\u0000${input.idempotencyKey}`;
              const fingerprint = JSON.stringify([
                input.harness ?? null,
                input.model ?? null,
                input.onBehalfOf ?? null,
              ]);
              const known = byKey.get(key);
              if (known !== undefined) {
                if (known.fingerprint === fingerprint) return known.session;
                return yield* new IdempotencyConflict({ idempotencyKey: input.idempotencyKey });
              }
              const agent = found.value;
              if (agent.state !== "active")
                return yield* new AgentNotAdmitted({ agentId, reason: agent.state });
              const sponsor = principal.onBehalfOf ?? agent.onBehalfOf;
              if (input.onBehalfOf !== undefined && input.onBehalfOf !== sponsor)
                return yield* new SessionSponsorRefused({
                  agentId,
                  requested: input.onBehalfOf,
                  ...(sponsor === undefined ? {} : { sponsor }),
                });
              count += 1;
              const session: Session = {
                id: makeId("ses", ulidOf(count)),
                agentId,
                ...(input.harness === undefined ? {} : { harness: input.harness }),
                ...(input.model === undefined ? {} : { model: input.model }),
                ...(sponsor === undefined ? {} : { onBehalfOf: sponsor }),
                openedAt: Instant(Date.now()),
              };
              byKey.set(key, { session, fingerprint });
              current.set(agentId, session);
              return session;
            }),
          current: (agentId) => Effect.sync(() => current.get(agentId) ?? null),
        });
      }),
    ),
  };
}
