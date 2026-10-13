-- The agents of each namespace: one row an agent a member invited there. The
-- namespace's own object (`ns:<id>`) stays the authority: it writes its row
-- inline after each invitation event it commits, and the Projector repeats the
-- write on delivery; each write is guarded by `seq`, the number on the
-- namespace's own entity of the event the row last took, so a late or repeated
-- one never moves the row back. The request gate reads a row on every request
-- of an agent in a namespace that is not its own: only `joined` gives it
-- standing there. An ended invitation keeps its row, as `ended`, so the guard
-- still holds if the agent is invited again.
-- `scopes` is JSON text: `["agent:read"]`, or that and `"agent:work"`.
-- The index is by agent: the namespaces an agent was invited into.
-- Expand-only: a new table and its index.
CREATE TABLE namespace_agents (
  namespace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('invited', 'joined', 'ended')),
  seq INTEGER NOT NULL,
  invited_at INTEGER NOT NULL,
  joined_at INTEGER,
  PRIMARY KEY (namespace_id, agent_id)
);

CREATE INDEX namespace_agents_by_agent ON namespace_agents (agent_id);
