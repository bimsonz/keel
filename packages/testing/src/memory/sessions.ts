import {
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
} from "@keeltown/core/domain/identity";
import type { Session } from "@keeltown/core/domain/memory";
import { type AgentId, Instant, makeId, type RunId } from "@keeltown/core/kernel";
import { AgentDirectory, Sessions } from "@keeltown/core/ports";
import { Effect, Layer, Option } from "effect";
import { ulidOf } from "./operator.ts";

/** Where a run of an agent keeps its current session: under the agent alone when it names no run. */
const slot = (agentId: AgentId, run: RunId | undefined) => `${agentId}\u0000${run ?? ""}`;

/**
 * Sessions over an AgentDirectory, with the AgentSession DO's rules: the agent
 * must be known and active, the session's sponsor is the agent's from its
 * enrolment, a key replayed with its body answers its session, and each run of
 * an agent has a current session of its own.
 */
export function makeSessionsMemory() {
  /** The current session of each run of each agent; of the agent itself under no run. */
  const current = new Map<string, Session>();
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
              const fingerprint = JSON.stringify([input.harness ?? null, input.model ?? null]);
              const known = byKey.get(key);
              if (known !== undefined) {
                if (known.fingerprint === fingerprint) return known.session;
                return yield* new IdempotencyConflict({ idempotencyKey: input.idempotencyKey });
              }
              const agent = found.value;
              if (agent.state !== "active")
                return yield* new AgentNotAdmitted({ agentId, reason: agent.state });
              count += 1;
              const session: Session = {
                id: makeId("ses", ulidOf(count)),
                agentId,
                ...(input.harness === undefined ? {} : { harness: input.harness }),
                ...(input.model === undefined ? {} : { model: input.model }),
                ...(agent.sponsor === undefined ? {} : { sponsor: agent.sponsor }),
                ...(principal.run === undefined ? {} : { run: principal.run }),
                openedAt: Instant(Date.now()),
              };
              byKey.set(key, { session, fingerprint });
              current.set(slot(agentId, principal.run?.id), session);
              return session;
            }),
          current: (agentId, run) => Effect.sync(() => current.get(slot(agentId, run)) ?? null),
        });
      }),
    ),
  };
}
