-- The seq, on the agent's own entity, of the standing event (suspended,
-- reinstated, revoked) the row last took. The AgentSession DO writes standing
-- inline and the Projector repeats it on delivery; each write is guarded by
-- this seq, so a late or repeated one never moves the row back. Enrolment
-- leaves it alone.
ALTER TABLE agents ADD COLUMN standing_seq INTEGER NOT NULL DEFAULT 0;
