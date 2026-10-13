-- When a passkey last signed in, written as the sign-in verifies. Better Auth's
-- own row for a passkey holds a counter and no time. A passkey added before
-- this column reads no last use until its next sign-in: nothing is filled in
-- for it. A date as better-auth 1.7.7's compileMigrations writes one (0006's
-- `createdAt`), and held equal to the field `keyUse` declares by [ba.schema].
-- Expand-only: a nullable column.
alter table "passkey" add column "lastUsedAt" date;
