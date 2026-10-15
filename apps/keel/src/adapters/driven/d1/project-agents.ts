import { answersFor, Invitation } from "@keeltown/core/domain/identity";
import { ProjectAgents } from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";

/** A row of `project_agents`, decoded into the domain's Invitation. `scopes` is stored as JSON text. */
const Row = Schema.Struct({
  project_id: Schema.String,
  agent_id: Schema.String,
  namespace_id: Schema.String,
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
    projectId: r.project_id,
    agentId: r.agent_id,
    by: r.invited_by,
    scopes: JSON.parse(r.scopes),
    state: r.state,
    invitedAt: r.invited_at,
    ...(r.joined_at === null ? {} : { joinedAt: r.joined_at }),
  });
}

const COLUMNS =
  "project_id, agent_id, namespace_id, invited_by, scopes, state, invited_at, joined_at";

/**
 * `ProjectAgents` on D1's `project_agents`. Each write carries the seq of the
 * project event it projects and changes only a row below it; the read after it
 * says whether the row now holds that move or a later one, so a retried or
 * late write is told apart from one whose invitation has not been written yet.
 */
export function ProjectAgentsD1(db: D1Database) {
  const settled = async (projectId: string, agentId: string, seq: number): Promise<boolean> => {
    const row = await db
      .prepare("SELECT seq FROM project_agents WHERE project_id = ? AND agent_id = ?")
      .bind(projectId, agentId)
      .first<{ seq: number }>();
    return row !== null && row.seq >= seq;
  };
  return Layer.succeed(
    ProjectAgents,
    ProjectAgents.of({
      apply: (move, seq) =>
        Effect.promise(async () => {
          switch (move._tag) {
            case "Invited":
              await db
                .prepare(
                  `INSERT INTO project_agents (project_id, agent_id, namespace_id, invited_by, scopes, state, seq, invited_at, joined_at)
                   VALUES (?, ?, ?, ?, ?, 'invited', ?, ?, NULL)
                   ON CONFLICT (project_id, agent_id) DO UPDATE SET
                     namespace_id = excluded.namespace_id,
                     invited_by = excluded.invited_by,
                     scopes = excluded.scopes,
                     state = 'invited',
                     seq = excluded.seq,
                     invited_at = excluded.invited_at,
                     joined_at = NULL
                   WHERE project_agents.seq < excluded.seq`,
                )
                .bind(
                  move.projectId,
                  move.agentId,
                  move.namespace,
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
                  `UPDATE project_agents SET state = 'joined', joined_at = ?, seq = ?
                   WHERE project_id = ? AND agent_id = ? AND seq < ?`,
                )
                .bind(move.at, seq, move.projectId, move.agentId, seq)
                .run();
              break;
            case "Left":
              await db
                .prepare(
                  `UPDATE project_agents SET state = 'ended', seq = ?
                   WHERE project_id = ? AND agent_id = ? AND seq < ?`,
                )
                .bind(seq, move.projectId, move.agentId, seq)
                .run();
              break;
            default: {
              const unmatched: never = move;
              return unmatched;
            }
          }
          return settled(move.projectId, move.agentId, seq);
        }),
      standing: (agentId, projectId) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM project_agents
               WHERE project_id = ? AND agent_id = ? AND state = 'joined'`,
            )
            .bind(projectId, agentId)
            .first(),
        ).pipe(
          Effect.map((row) =>
            Option.fromUndefinedOr(row === null ? undefined : answersFor(toInvitation(row))),
          ),
        ),
      find: (agentId, projectId) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM project_agents
               WHERE project_id = ? AND agent_id = ? AND state <> 'ended'`,
            )
            .bind(projectId, agentId)
            .first(),
        ).pipe(
          Effect.map((row) => (row === null ? Option.none() : Option.some(toInvitation(row)))),
        ),
      inProject: (projectId) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM project_agents
               WHERE project_id = ? AND state <> 'ended' ORDER BY invited_at, agent_id`,
            )
            .bind(projectId)
            .all(),
        ).pipe(Effect.map(({ results }) => results.map(toInvitation))),
      ofAgent: (agentId) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT ${COLUMNS} FROM project_agents
               WHERE agent_id = ? AND state <> 'ended' ORDER BY invited_at, project_id`,
            )
            .bind(agentId)
            .all(),
        ).pipe(Effect.map(({ results }) => results.map(toInvitation))),
      ended: (agentId, projectId) =>
        Effect.promise(() =>
          db
            .prepare(
              `SELECT 1 AS ended FROM project_agents
               WHERE project_id = ? AND agent_id = ? AND state = 'ended'`,
            )
            .bind(projectId, agentId)
            .first(),
        ).pipe(Effect.map((row) => row !== null)),
    }),
  );
}
