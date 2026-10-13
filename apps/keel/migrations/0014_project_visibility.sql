-- A project's visibility, mirrored beside its place so a list of projects is
-- narrowed where it is read. The Project DO stays the authority: it writes
-- the mirror inline after each settings commit that moves visibility, and the
-- Projector repeats it on delivery; each write is guarded by `visibility_seq`,
-- the seq on the project's own entity of the settings event the row last
-- took, so a late or repeated one never moves the row back. Every project is
-- private until a settings change says otherwise, and so is every row.
-- The index holds the public projects alone, by id: what a visitor's list reads.
-- Expand-only: two defaulted columns and an index.
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE projects ADD COLUMN visibility_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX projects_public ON projects (id) WHERE visibility = 'public';
