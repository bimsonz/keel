-- An agent may be `synthetic`: the load generator's agents, enrolled by the
-- operator. SQLite cannot widen a CHECK in place, so `agents` is rebuilt with
-- every column 0001–0003 gave it. Dropping a table that credentials still
-- reference counts every credential as a foreign key violation, even deferred
-- and even once the new table takes the old name, so credentials are set aside
-- first and restored, with their foreign key, after the rebuild.
CREATE TABLE credentials_kept AS SELECT client_id, agent_id, secret_hash FROM credentials;
DROP TABLE credentials;

CREATE TABLE agents_v2 (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('interactive', 'hosted', 'human', 'synthetic')),
  scopes           TEXT NOT NULL, -- JSON array of scope strings
  state            TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
  revocation_epoch INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  project_id       TEXT NOT NULL DEFAULT '',
  on_behalf_of     TEXT
);
INSERT INTO agents_v2 (id, name, kind, scopes, state, revocation_epoch, created_at, project_id, on_behalf_of)
  SELECT id, name, kind, scopes, state, revocation_epoch, created_at, project_id, on_behalf_of FROM agents;
DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;
CREATE INDEX agents_by_project ON agents (project_id);

-- A client credential stores only the SHA-256 of its secret.
CREATE TABLE credentials (
  client_id   TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  secret_hash TEXT NOT NULL
);
INSERT INTO credentials (client_id, agent_id, secret_hash)
  SELECT client_id, agent_id, secret_hash FROM credentials_kept;
DROP TABLE credentials_kept;
CREATE INDEX credentials_by_agent ON credentials (agent_id);
