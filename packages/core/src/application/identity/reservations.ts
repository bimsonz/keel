import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import { type AgentId, ChangeId, type Instant, InstantSchema } from "../../domain/kernel/index.ts";
import { Clock, commit, type EntityStore, type EventOutbox, Ids } from "../ports/index.ts";

/** A declare's Idempotency-Key keeps its change id this long. */
export const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** One row per Idempotency-Key in the agent's AgentSession DO. */
const Reservation = Schema.Struct({
  changeId: ChangeId,
  fingerprint: Schema.String,
  at: InstantSchema,
});
export const RESERVATION = "change-reservation";

export interface ReserveChangeRequest {
  readonly idempotencyKey: string;
  /** A hash of the declare's body, so a reused key with a different body is told apart from a retry. */
  readonly fingerprint: string;
}

/**
 * The change id for a declare's Idempotency-Key: minted on first use and kept
 * for 24 h, so a retried declare reaches the same change. The same key with a
 * different fingerprint is an IdempotencyConflict. Expiry is computed on read:
 * an expired row is replaced, and nothing is scheduled to remove it.
 */
export const reserveChange: (
  agentId: AgentId,
  request: ReserveChangeRequest,
) => Effect.Effect<ChangeId, IdempotencyConflict, Clock | Ids | EntityStore | EventOutbox> =
  Effect.fn("identity/reserveChange")(function* (agentId: AgentId, request: ReserveChangeRequest) {
    const minted = yield* (yield* Ids).next("chg");
    const now: Instant = yield* (yield* Clock).now;
    const committed = yield* commit(
      { entity: { kind: "agent", id: agentId }, cause: `reserve:${request.idempotencyKey}` },
      ({ store }) => {
        const stored = store.get(RESERVATION, request.idempotencyKey);
        const held =
          stored === undefined ? undefined : Schema.decodeUnknownSync(Reservation)(stored);
        if (held !== undefined && now - held.at < RESERVATION_TTL_MS) {
          return held.fingerprint === request.fingerprint
            ? Result.succeed({ drafts: [], value: held.changeId })
            : Result.fail(new IdempotencyConflict({ idempotencyKey: request.idempotencyKey }));
        }
        store.put(
          RESERVATION,
          request.idempotencyKey,
          Schema.encodeSync(Reservation)({
            changeId: minted,
            fingerprint: request.fingerprint,
            at: now,
          }),
        );
        return Result.succeed({ drafts: [], value: minted });
      },
    );
    // A reservation commits no events, so its cause never reads as already committed.
    if (committed.duplicate) return yield* Effect.die("a reservation committed events");
    return committed.value;
  });
