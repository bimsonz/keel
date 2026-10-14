-- The time of the passkey a device sign-in's approval was made with, in epoch
-- milliseconds. A person approving a terminal's code with a passkey sign-in
-- from the last ten minutes (or from a terminal whose own approval was) gives
-- the code that passkey's time, and `/device/token` copies it onto the
-- terminal's session, whose `signedInBy` stays `device`. For ten minutes from
-- that passkey the session may invite agents and take them off, and approve
-- or end a sponsorship; it never changes how its account signs in. Nothing
-- after the approval writes either column. The session's is one of its
-- additionalFields, held equal to them by [ba.schema]; the code's is Keel's
-- own, written and read by the hooks in auth.ts.
-- Expand-only: two nullable columns.
alter table "session" add column "passkeyAt" integer;
alter table "deviceCode" add column "passkeyAt" integer;
