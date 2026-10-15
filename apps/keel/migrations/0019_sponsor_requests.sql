-- The sponsor requests agents address to people: one row an agent and a person.
-- The agent's own object (its AgentSession) stays the authority: it writes the
-- row inline after each request event it commits, guarded by `seq`, the number
-- on the agent's own entity of the event the row last took, so a late or
-- repeated write never moves the row back. A request waits while `expires_at`
-- is set and later than now; `blocked_at` is set while the person blocks the
-- agent. A person's own list reads the rows waiting for them, and the agent's
-- object counts them before it takes another request for that person.
-- The index is by person: the requests waiting for one person, and whom they blocked.
-- Expand-only: a new table and its index.
CREATE TABLE sponsor_requests (
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  asked_at INTEGER,
  expires_at INTEGER,
  blocked_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, person_id)
);

CREATE INDEX sponsor_requests_by_person ON sponsor_requests (person_id, expires_at);
