import { AgentId, Instant, UserId } from "@keeltown/core/kernel";
import { type SponsorRequestRow, SponsorRequests } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";

const Row = Schema.Struct({
  agent_id: Schema.String,
  person_id: Schema.String,
  asked_at: Schema.NullOr(Schema.Number),
  expires_at: Schema.NullOr(Schema.Number),
  blocked_at: Schema.NullOr(Schema.Number),
});
const decodeRow = Schema.decodeUnknownSync(Row);
const decodeAgentId = Schema.decodeUnknownSync(AgentId);
const decodeUserId = Schema.decodeUnknownSync(UserId);

function toRow(row: unknown): SponsorRequestRow {
  const r = decodeRow(row);
  return {
    agentId: decodeAgentId(r.agent_id),
    person: decodeUserId(r.person_id),
    ...(r.asked_at === null ? {} : { askedAt: Instant(r.asked_at) }),
    ...(r.expires_at === null ? {} : { expiresAt: Instant(r.expires_at) }),
    ...(r.blocked_at === null ? {} : { blockedAt: Instant(r.blocked_at) }),
  };
}

const COLUMNS = "agent_id, person_id, asked_at, expires_at, blocked_at";

/**
 * `SponsorRequests` on D1's `sponsor_requests`. Each write carries the seq of
 * the agent event it projects and changes only a row below it.
 */
export function SponsorRequestsD1(db: D1Database) {
  return Layer.succeed(
    SponsorRequests,
    SponsorRequests.of({
      apply: (row, seq) =>
        Effect.promise(async () => {
          await db
            .prepare(
              `INSERT INTO sponsor_requests (agent_id, person_id, asked_at, expires_at, blocked_at, seq)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (agent_id, person_id) DO UPDATE SET
                 asked_at = excluded.asked_at,
                 expires_at = excluded.expires_at,
                 blocked_at = excluded.blocked_at,
                 seq = excluded.seq
               WHERE sponsor_requests.seq < excluded.seq`,
            )
            .bind(
              row.agentId,
              row.person,
              row.askedAt ?? null,
              row.expiresAt ?? null,
              row.blockedAt ?? null,
              seq,
            )
            .run();
        }),
      settle: (agentId) =>
        Effect.promise(async () => {
          await db
            .prepare(
              "UPDATE sponsor_requests SET asked_at = NULL, expires_at = NULL WHERE agent_id = ?",
            )
            .bind(agentId)
            .run();
        }),
      waitingFor: (person, now) =>
        Effect.promise(async () => {
          const { results } = await db
            .prepare(
              `SELECT ${COLUMNS} FROM sponsor_requests
               WHERE person_id = ? AND expires_at > ? ORDER BY asked_at, agent_id`,
            )
            .bind(person, now)
            .all();
          return results.map(toRow);
        }),
      waitingCount: (person, now) =>
        Effect.promise(async () => {
          const row = await db
            .prepare(
              "SELECT COUNT(*) AS n FROM sponsor_requests WHERE person_id = ? AND expires_at > ?",
            )
            .bind(person, now)
            .first<{ n: number }>();
          return row?.n ?? 0;
        }),
      blockedBy: (person) =>
        Effect.promise(async () => {
          const { results } = await db
            .prepare(
              `SELECT ${COLUMNS} FROM sponsor_requests
               WHERE person_id = ? AND blocked_at IS NOT NULL ORDER BY blocked_at, agent_id`,
            )
            .bind(person)
            .all();
          return results.map(toRow);
        }),
    }),
  );
}
