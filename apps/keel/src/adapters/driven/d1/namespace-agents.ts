import { answersFor, Invitation } from "@keeltown/core/domain/identity";
import { NamespaceAgents } from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";

/** A row of `namespace_agents`, decoded into the domain's Invitation. `scopes` is stored as JSON text. */
const Row = Schema.Struct({
  namespace_id: Schema.String,
  agent_id: Schema.String,
  invited_by: Schema.String,
  scopes: Schema.String,
  state: Schema.String,
  invited_at: Schema.Number,
  joined_at: Schema.NullOr(Schema.Number),
});

const decodeRow = Schema.decodeUnknownSync(Row);
const decodeInvitation = Schema.decodeUnknownSync(Invitation);

function toInvitation(row: unknown): Invitation {
  const r = decodeRow(row);
  return decodeInvitation({
    namespace: r.namespace_id,
    agentId: r.agent_id,
    by: r.invited_by,
    scopes: JSON.parse(r.scopes),
    state: r.state,
    invitedAt: r.invited_at,
    ...(r.joined_at === null ? {} : { joinedAt: r.joined_at }),
  });
}

const COLUMNS = "namespace_id, agent_id, invited_by, scopes, state, invited_at, joined_at";

/**
 * `NamespaceAgents` on D1's `namespace_agents`. Each write carries the seq of
 * the namespace event it projects and changes only a row below it; the read
 * after it says whether the row now holds that move or a later one, so a
 * retried or late write is told apart from one whose invitation has not been
 * written yet.
 */
export function NamespaceAgentsD1(db: D1Database) {
  const settled = async (namespace: string, agentId: string, seq: number): Promise<boolean> => {
    const row = await db
      .prepare("SELECT seq FROM namespace_agents WHERE namespace_id = ? AND agent_id = ?")
      .bind(namespace, agentId)
      .first<{ seq: number }>();
    return row !== null && row.seq >= seq;
  };
  return Layer.succeed(
    NamespaceAgents,
    NamespaceAgents.of({
      apply: (move, seq) =>
        Effect.promise(async () => {
          switch (move._tag) {
            case "Invited":
              await db
                .prepare(
                  `INSERT INTO namespace_agents (namespace_id, agent_id, invited_by, scopes, state, seq, invited_at, joined_at)
                   VALUES (?, ?, ?, ?, 'invited', ?, ?, NULL)
                   ON CONFLICT (namespace_id, agent_id) DO UPDATE SET
                     invited_by = excluded.invited_by,
                     scopes = excluded.scopes,
                     state = 'invited',
                     seq = excluded.seq,
                     invited_at = excluded.invited_at,
                     joined_at = NULL
                   WHERE namespace_agents.seq < excluded.seq`,
                )
                .bind(
                  move.namespace,
                  move.agentId,
                  move.by,
                  JSON.stringify(move.scopes),
                  seq,
                  move.at,
                )
                .run();
              break;
            case "Joined":
              await db
                .prepare(
                  `UPDATE namespace_agents SET state = 'joined', joined_at = ?, seq = ?
                   WHERE namespace_id = ? AND agent_id = ? AND seq < ?`,
                )
                .bind(move.at, seq, move.namespace, move.agentId, seq)
                .run();
              break;
            case "Left":
              await db
                .prepare(
                  `UPDATE namespace_agents SET state = 'ended', seq = ?
                   WHERE namespace_id = ? AND agent_id = ? AND seq < ?`,
                )
                .bind(seq, move.namespace, move.agentId, seq)
                .run();
              break;
            default: {
              const unmatched: never = move;
              return unmatched;
            }
          }
          return settled(move.namespace, move.agentId, seq);
        }),
      standing: (agentId, namespace) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM namespace_agents
               WHERE namespace_id = ? AND agent_id = ? AND state = 'joined'`,
            )
            .bind(namespace, agentId)
            .first(),
        ).pipe(
          Effect.map((row) =>
            Option.fromUndefinedOr(row === null ? undefined : answersFor(toInvitation(row))),
          ),
        ),
      find: (agentId, namespace) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM namespace_agents
               WHERE namespace_id = ? AND agent_id = ? AND state <> 'ended'`,
            )
            .bind(namespace, agentId)
            .first(),
        ).pipe(
          Effect.map((row) => (row === null ? Option.none() : Option.some(toInvitation(row)))),
        ),
      inNamespace: (namespace) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM namespace_agents
               WHERE namespace_id = ? AND state <> 'ended' ORDER BY invited_at, agent_id`,
            )
            .bind(namespace)
            .all(),
        ).pipe(Effect.map(({ results }) => results.map(toInvitation))),
      ofAgent: (agentId) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM namespace_agents
               WHERE agent_id = ? AND state <> 'ended' ORDER BY invited_at, namespace_id`,
            )
            .bind(agentId)
            .all(),
        ).pipe(Effect.map(({ results }) => results.map(toInvitation))),
      ended: (agentId, namespace) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT 1 AS ended FROM namespace_agents
               WHERE namespace_id = ? AND agent_id = ? AND state = 'ended'`,
            )
            .bind(namespace, agentId)
            .first(),
        ).pipe(Effect.map((row) => row !== null)),
    }),
  );
}
