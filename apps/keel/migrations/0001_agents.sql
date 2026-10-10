-- The agent directory: a projection of each AgentSession DO, read by the
-- isolate to authenticate a request without a DO round trip.
CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('interactive', 'hosted', 'human')),
  scopes           TEXT NOT NULL, -- JSON array of scope strings
  state            TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
  revocation_epoch INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

-- A client credential stores only the SHA-256 of its secret.
CREATE TABLE credentials (
  client_id   TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  secret_hash TEXT NOT NULL
);

CREATE INDEX credentials_by_agent ON credentials (agent_id);
