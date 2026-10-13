-- The seq, on the agent's own entity, of the sponsor link's event (sponsored,
-- unsponsored) the row last took. The AgentSession DO writes `sponsor_user`
-- inline and the Projector repeats it on delivery; each write is guarded by
-- this seq, so a late or repeated one never moves the row back. While it is
-- 0 the row holds what enrolment wrote; once a link event has written it,
-- enrolment's projection leaves the sponsor alone. The index is for a
-- person's own list of the agents they stand behind.
-- Expand-only: a defaulted column and an index.
ALTER TABLE agents ADD COLUMN sponsor_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX agents_by_sponsor ON agents (sponsor_user);
