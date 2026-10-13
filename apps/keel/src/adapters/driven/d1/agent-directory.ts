import { Agent, AgentKey } from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import { AgentDirectory, type StoredCredential } from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";

/**
 * A row of `agents`, decoded into the domain's Agent. `scopes` is stored as
 * JSON text. An agent that signed up by key has a handle, an empty `project_id`
 * and no kind.
 */
const AgentRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  handle: Schema.NullOr(Schema.String),
  name: Schema.String,
  kind: Schema.NullOr(Schema.String),
  scopes: Schema.String,
  namespace_id: Schema.NullOr(Schema.String),
  sponsor_user: Schema.NullOr(Schema.String),
  state: Schema.String,
  revocation_epoch: Schema.Number,
  created_at: Schema.Number,
});

/** A row of `agent_keys`: one public key of one agent. `jwk` is stored as JSON text. */
const KeyRow = Schema.Struct({
  jkt: Schema.String,
  jwk: Schema.String,
  created_at: Schema.Number,
});

const decodeAgent = Schema.decodeUnknownSync(Agent);
const decodeAgentId = Schema.decodeUnknownSync(AgentId);
const decodeKeyRows = Schema.decodeUnknownSync(Schema.Array(KeyRow));
const encodeKey = Schema.encodeSync(AgentKey);

function toAgent(row: unknown, keyRows: unknown): Agent {
  const r = Schema.decodeUnknownSync(AgentRow)(row);
  const keys = decodeKeyRows(keyRows).map((key) => ({
    jkt: key.jkt,
    jwk: JSON.parse(key.jwk),
    addedAt: key.created_at,
  }));
  return decodeAgent({
    id: r.id,
    ...(r.project_id === "" ? {} : { projectId: r.project_id }),
    ...(r.handle === null ? {} : { handle: r.handle }),
    name: r.name,
    ...(r.kind === null ? {} : { kind: r.kind }),
    scopes: JSON.parse(r.scopes),
    ...(keys.length === 0 ? {} : { keys }),
    ...(r.namespace_id === null ? {} : { org: r.namespace_id }),
    ...(r.sponsor_user === null ? {} : { sponsor: r.sponsor_user }),
    state: r.state,
    revocationEpoch: r.revocation_epoch,
    createdAt: r.created_at,
  });
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * The agent directory on D1: a projection the isolate reads to authenticate a
 * request without a Durable Object round trip. A row that fails to decode is a
 * defect, not a missing agent.
 */
export function AgentDirectoryD1(db: D1Database) {
  return Layer.succeed(
    AgentDirectory,
    AgentDirectory.of({
      // One round trip for the row and its keys: the gate reads this on every request.
      findAgent: (agentId) =>
        Effect.promise(() =>
          db.batch([
            db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId),
            db
              .prepare(
                "SELECT jkt, jwk, created_at FROM agent_keys WHERE agent_id = ? ORDER BY created_at, jkt",
              )
              .bind(agentId),
          ]),
        ).pipe(
          Effect.map(([found, keys]) => {
            const row = found?.results[0];
            return row === undefined ? Option.none() : Option.some(toAgent(row, keys?.results));
          }),
        ),
      findCredential: (clientId) =>
        Effect.promise(() =>
          db
            .prepare("SELECT client_id, agent_id, secret_hash FROM credentials WHERE client_id = ?")
            .bind(clientId)
            .first<{
              client_id: string;
              agent_id: string;
              secret_hash: string;
            }>(),
        ).pipe(
          Effect.map((row) =>
            row === null
              ? Option.none()
              : Option.some<StoredCredential>({
                  clientId: row.client_id,
                  agentId: decodeAgentId(row.agent_id),
                  secretHash: row.secret_hash,
                }),
          ),
        ),
      verifyCredential: (clientId, secret) =>
        Effect.promise(async () => {
          const row = await db
            .prepare("SELECT agent_id, secret_hash FROM credentials WHERE client_id = ?")
            .bind(clientId)
            .first<{
              agent_id: string;
              secret_hash: string;
            }>();
          if (row === null) return Option.none();
          return constantTimeEqual(await hashSecret(secret), row.secret_hash)
            ? Option.some(decodeAgentId(row.agent_id))
            : Option.none();
        }),
      standing: (agentId, standing, seq) =>
        Effect.promise(() =>
          db
            .prepare(
              `UPDATE agents SET state = ?, revocation_epoch = COALESCE(?, revocation_epoch), standing_seq = ?
               WHERE id = ? AND standing_seq < ?`,
            )
            .bind(standing.state, standing.revocationEpoch ?? null, seq, agentId, seq)
            .run(),
        ).pipe(Effect.asVoid),
      sponsor: (agentId, sponsor, seq) =>
        Effect.promise(() =>
          db
            .prepare(
              "UPDATE agents SET sponsor_user = ?, sponsor_seq = ? WHERE id = ? AND sponsor_seq < ?",
            )
            .bind(sponsor, seq, agentId, seq)
            .run(),
        ).pipe(Effect.asVoid),
      sponsoredBy: (userId) =>
        Effect.promise(() =>
          db
            .prepare("SELECT * FROM agents WHERE sponsor_user = ? ORDER BY created_at, id")
            .bind(userId)
            .all(),
        ).pipe(Effect.map(({ results }) => results.map(toAgent))),
      // An agent's namespace, once placed, is never moved or cleared by a later write: its project never
      // moves, and an enrolment replayed by its key carries the namespace it was first made in, which
      // migration 0010 may since have re-homed. Its sponsor is never cleared by a record that lacks one.
      // Once a sponsor link's event has written the sponsor (`sponsor_seq` > 0), only such an event moves it.
      upsert: (agent, credential) =>
        Effect.promise(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO agents (id, project_id, name, kind, scopes, namespace_id, sponsor_user, state, revocation_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, kind = excluded.kind, scopes = excluded.scopes,
                   namespace_id = COALESCE(agents.namespace_id, excluded.namespace_id),
                   sponsor_user = CASE WHEN agents.sponsor_seq > 0 THEN agents.sponsor_user ELSE COALESCE(excluded.sponsor_user, agents.sponsor_user) END,
                   state = excluded.state,
                   revocation_epoch = excluded.revocation_epoch`,
              )
              .bind(
                agent.id,
                agent.projectId ?? "",
                agent.name,
                agent.kind ?? null,
                JSON.stringify(agent.scopes),
                agent.org ?? null,
                agent.sponsor ?? null,
                agent.state,
                agent.revocationEpoch,
                agent.createdAt,
              ),
            db
              .prepare(
                `INSERT INTO credentials (client_id, agent_id, secret_hash) VALUES (?, ?, ?)
                 ON CONFLICT (client_id) DO UPDATE SET agent_id = excluded.agent_id, secret_hash = excluded.secret_hash`,
              )
              .bind(credential.clientId, credential.agentId, credential.secretHash),
          ]),
        ).pipe(Effect.asVoid),
      // The keys are replaced whole, in the row's own transaction. A key another agent holds
      // fails the batch: a key names one agent, and `agent_keys.jkt` is what holds that.
      upsertAccount: (agent) =>
        Effect.promise(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO agents (id, project_id, handle, name, kind, scopes, state, revocation_epoch, created_at) VALUES (?, '', ?, ?, NULL, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET handle = excluded.handle, name = excluded.name, scopes = excluded.scopes, state = excluded.state,
                   revocation_epoch = excluded.revocation_epoch`,
              )
              .bind(
                agent.id,
                agent.handle ?? null,
                agent.name,
                JSON.stringify(agent.scopes),
                agent.state,
                agent.revocationEpoch,
                agent.createdAt,
              ),
            db.prepare("DELETE FROM agent_keys WHERE agent_id = ?").bind(agent.id),
            ...(agent.keys ?? []).map((key) => {
              const encoded = encodeKey(key);
              return db
                .prepare(
                  "INSERT INTO agent_keys (jkt, agent_id, jwk, created_at) VALUES (?, ?, ?, ?)",
                )
                .bind(encoded.jkt, agent.id, JSON.stringify(encoded.jwk), encoded.addedAt);
            }),
          ]),
        ).pipe(Effect.asVoid),
    }),
  );
}
