import { Agent } from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import { AgentDirectory, type StoredCredential } from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";

/** A row of `agents`, decoded into the domain's Agent. `scopes` is stored as JSON text. */
const AgentRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  scopes: Schema.String,
  state: Schema.String,
  revocation_epoch: Schema.Number,
  created_at: Schema.Number,
});

const decodeAgent = Schema.decodeUnknownSync(Agent);
const decodeAgentId = Schema.decodeUnknownSync(AgentId);

function toAgent(row: unknown): Agent {
  const r = Schema.decodeUnknownSync(AgentRow)(row);
  return decodeAgent({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    kind: r.kind,
    scopes: JSON.parse(r.scopes),
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
      findAgent: (agentId) =>
        Effect.promise(() =>
          db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId).first(),
        ).pipe(Effect.map((row) => (row === null ? Option.none() : Option.some(toAgent(row))))),
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
      upsert: (agent, credential) =>
        Effect.promise(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO agents (id, project_id, name, kind, scopes, state, revocation_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, kind = excluded.kind, scopes = excluded.scopes,
                   state = excluded.state, revocation_epoch = excluded.revocation_epoch`,
              )
              .bind(
                agent.id,
                agent.projectId,
                agent.name,
                agent.kind,
                JSON.stringify(agent.scopes),
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
    }),
  );
}
