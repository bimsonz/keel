-- Namespaces with a kind. A namespace is a handle that owns
-- projects: a person's own, an agent's own, or an org. Its id is its account's
-- id (usr_, agt_ or org_), and its handle is unique across all three kinds, so
-- one name for one account is the table's own guarantee.
--
-- The database writes the rows. A trigger inserts a person's namespace in the
-- statement that gives the user its handle, and an org's in the statement that
-- inserts the organization, so a handle already held refuses the sign-up or
-- the org itself and nothing is left to undo. A row is never deleted: the
-- handle of an account that is gone is not issued again.
--
-- Not expand-only. Until now every person had a personal org, a Better Auth
-- organization named after them. Their projects and agents move to the
-- person's own namespace (the user's id), and then each personal org's
-- organization, member and invitation rows are deleted, and a session that had
-- one active has none. No project, agent, user or other org is deleted.
CREATE TABLE namespaces (
  id         TEXT PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'org')),
  created_at INTEGER NOT NULL
);

-- Every person with a handle, under their own id.
INSERT INTO namespaces (id, handle, kind, created_at)
SELECT id, username, 'user',
       COALESCE(CAST(strftime('%s', createdAt) AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)) * 1000
FROM "user"
WHERE username IS NOT NULL;

-- Every org that is no person's personal org: one no user is named after.
INSERT INTO namespaces (id, handle, kind, created_at)
SELECT id, slug, 'org',
       COALESCE(CAST(strftime('%s', createdAt) AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)) * 1000
FROM organization
WHERE slug NOT IN (SELECT username FROM "user" WHERE username IS NOT NULL);

ALTER TABLE projects RENAME COLUMN org_id TO namespace_id;

ALTER TABLE agents RENAME COLUMN org_id TO namespace_id;

DROP INDEX projects_by_org_name;

CREATE UNIQUE INDEX projects_by_namespace_name ON projects (namespace_id, name);

-- A personal org's projects and agents become its person's own.
UPDATE projects
SET namespace_id = (
  SELECT u.id FROM organization o JOIN "user" u ON u.username = o.slug
  WHERE o.id = projects.namespace_id
)
WHERE namespace_id IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);

UPDATE agents
SET namespace_id = (
  SELECT u.id FROM organization o JOIN "user" u ON u.username = o.slug
  WHERE o.id = agents.namespace_id
)
WHERE namespace_id IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);

-- The personal orgs go: whatever pointed at one, then the orgs themselves.
UPDATE session
SET activeOrganizationId = NULL
WHERE activeOrganizationId IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);

DELETE FROM invitation
WHERE organizationId IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);

DELETE FROM member
WHERE organizationId IN (
  SELECT o.id FROM organization o JOIN "user" u ON u.username = o.slug
);

DELETE FROM organization
WHERE slug IN (SELECT username FROM "user" WHERE username IS NOT NULL);

-- From here on the rows are written with their accounts.
CREATE TRIGGER namespaces_user_signed_up
AFTER INSERT ON "user"
WHEN NEW.username IS NOT NULL
BEGIN
  INSERT INTO namespaces (id, handle, kind, created_at)
  VALUES (NEW.id, NEW.username, 'user', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER namespaces_user_took_handle
AFTER UPDATE OF username ON "user"
WHEN NEW.username IS NOT NULL AND OLD.username IS NULL
BEGIN
  INSERT INTO namespaces (id, handle, kind, created_at)
  VALUES (NEW.id, NEW.username, 'user', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER namespaces_org_created
AFTER INSERT ON organization
BEGIN
  INSERT INTO namespaces (id, handle, kind, created_at)
  VALUES (NEW.id, NEW.slug, 'org', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
