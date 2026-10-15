-- The project each run of an agent chose to work in (`Agents_useProject`): one
-- row a run, which a later choice replaces. The token endpoint mints a run's
-- token for this project when the request names none, and the request gate
-- refuses a token of the run that names no project once a row is here. Like a
-- token request's `project`, the choice is no event: the row is all of it.
-- Expand-only: a new table.
CREATE TABLE agent_run_projects (
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  chosen_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, run_id)
);
