-- The agents invited to one project: one row an agent the person whose
-- namespace the project is in invited to it. In a person's own namespace an
-- agent is taken on a project, never on the whole namespace, so the row is the
-- project's and not the namespace's (`namespace_agents` holds an org's).
-- The project's own object (`project:<id>`) stays the authority: it writes its
-- row inline after each invitation event it commits, and the Projector repeats
-- the write on delivery; each write is guarded by `seq`, the number on the
-- project's own entity of the event the row last took, so a late or repeated
-- one never moves the row back. The request gate reads a row on every request
-- of an agent whose token names a project of a namespace that is no org and
-- not the agent's own: only `joined` gives it standing, on that project alone.
-- An ended invitation keeps its row, as `ended`, so the guard still holds if
-- the agent is invited again.
-- `namespace_id` is the project's namespace when the invitation was made.
-- `scopes` is JSON text: `["agent:read"]`, or that and `"agent:work"`.
-- The index is by agent: the projects an agent was invited to.
-- Expand-only: a new table and its index.
CREATE TABLE project_agents (
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('invited', 'joined', 'ended')),
  seq INTEGER NOT NULL,
  invited_at INTEGER NOT NULL,
  joined_at INTEGER,
  PRIMARY KEY (project_id, agent_id)
);

CREATE INDEX project_agents_by_agent ON project_agents (agent_id);
