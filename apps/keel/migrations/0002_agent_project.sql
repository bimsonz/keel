-- Each agent is enrolled in exactly one project, carried in its tokens as the
-- `prj` claim. No agent rows existed before this migration, so the empty
-- default never reaches a decoder.
ALTER TABLE agents ADD COLUMN project_id TEXT NOT NULL DEFAULT '';

CREATE INDEX agents_by_project ON agents (project_id);
