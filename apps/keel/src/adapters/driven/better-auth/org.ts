/**
 * Orgs as Keel shows them: a member is invited by handle, and no answer
 * carries another member's email. Better Auth keys an invitation to an email
 * address, so an invitation by handle is stored under the invitee's own address
 * beside the handle, and every answer is rewritten for the person reading it.
 */
import { strongestRole } from "@keeltown/core/domain/identity";
import type { NextAction } from "@keeltown/core/kernel";
import { APIError, type createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { Result } from "effect";
import { decideAsRole } from "./roles.ts";

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The roles that manage an org's members and invitations (ManageMembers needs `maintain`). */
const MANAGERS: ReadonlySet<string> = new Set(["owner", "maintainer"]);

/** Better Auth's refusals when the last owner would leave, be removed, or step down. */
const LAST_OWNER: ReadonlySet<string> = new Set([
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
]);

const refuse = (code: string, message: string) => APIError.from("BAD_REQUEST", { code, message });

/** One answer for an unknown invitation and for someone else's: only its recipient learns it exists. */
const NOT_FOUND = () => refuse("INVITATION_NOT_FOUND", "No such invitation");

interface Invitation {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly status: string;
  readonly expiresAt: Date | string | number;
  readonly handle?: string | null;
}

interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly username?: string | null;
}

/** Who reads an answer: their own email, and the orgs whose invitations they manage. */
export interface Reader {
  readonly userId?: string;
  readonly email?: string;
  readonly manages: ReadonlySet<string>;
}

const byHandle = (invitation: { readonly handle?: unknown }): invitation is { handle: string } =>
  typeof invitation.handle === "string" && invitation.handle !== "";

/**
 * The invitee: the user holding the invitation's handle, or, for one typed by
 * email, the user who verified that address.
 */
const isRecipient = (invitation: Invitation, user: SessionUser): boolean =>
  byHandle(invitation)
    ? user.username === invitation.handle
    : user.emailVerified && invitation.email.toLowerCase() === user.email.toLowerCase();

const pendingNow = (invitation: Invitation): boolean =>
  invitation.status === "pending" && new Date(invitation.expiresAt) >= new Date();

/** An invitation names exactly one of a handle or an email; a handle becomes its user's address. */
async function inviteTarget(ctx: HookContext, db: D1Database) {
  const body: Record<string, unknown> = ctx.body ?? {};
  const { handle, email } = body;
  const toHandle = typeof handle === "string" && handle !== "";
  const toEmail = typeof email === "string" && email !== "";
  if (toHandle === toEmail)
    throw refuse("INVITE_TARGET", "Invite by exactly one of a handle or an email address");
  if (toEmail) {
    if (/\.invalid$/i.test(email.trim()))
      throw refuse(
        "EMAIL_UNDELIVERABLE",
        "That address can't receive mail, so no one could accept",
      );
    return undefined;
  }
  const user = await db
    .prepare(`SELECT email, username FROM user WHERE username = ?1`)
    .bind(String(handle).toLowerCase())
    .first<{ email: string; username: string }>();
  if (user === null) throw refuse("NO_SUCH_HANDLE", `No one has the handle "${String(handle)}"`);
  return { context: { body: { ...body, handle: user.username, email: user.email } } };
}

/**
 * Reading or answering an invitation: told only to its recipient, and in
 * words, whether it was answered or has lapsed.
 */
async function answerable(ctx: HookContext, id: unknown) {
  const session = await getSessionFromCtx(ctx);
  if (session === null || typeof id !== "string") return;
  const invitation = await ctx.context.adapter.findOne<Invitation>({
    model: "invitation",
    where: [{ field: "id", value: id }],
  });
  if (invitation === null || !isRecipient(invitation, session.user)) throw NOT_FOUND();
  if (invitation.status !== "pending")
    throw refuse("INVITATION_ANSWERED", `This invitation was already ${invitation.status}`);
  if (!pendingNow(invitation))
    throw refuse("INVITATION_LAPSED", "This invitation has lapsed; ask the org for a new one");
}

/**
 * The session's own pending invitations. Better Auth lists them only for a
 * verified email, which a passkey-first user doesn't have, so Keel answers:
 * those to the user's handle, and those to the address it verified.
 */
async function ownInvitations(ctx: HookContext, db: D1Database) {
  const session = await getSessionFromCtx(ctx);
  if (session === null) return undefined;
  const { user } = session;
  const where = [
    ...(typeof user.username === "string" ? [{ field: "handle", value: user.username }] : []),
    ...(user.emailVerified ? [{ field: "email", value: user.email.toLowerCase() }] : []),
  ];
  const found = new Map<string, Invitation & { organization?: { name: string; slug: string } }>();
  for (const clause of where) {
    const rows = await ctx.context.adapter.findMany<
      Invitation & { organization?: { name: string; slug: string } }
    >({ model: "invitation", where: [clause], join: { organization: true } });
    for (const row of rows) found.set(row.id, row);
  }
  const mine = [...found.values()]
    .filter((invitation) => isRecipient(invitation, user) && pendingNow(invitation))
    .map(({ organization, ...invitation }) => ({
      ...invitation,
      organizationName: organization?.name,
      organizationSlug: organization?.slug,
    }));
  return ctx.json(await shown(db, mine, await readerOf(ctx, db)));
}

/** The roles a request or a member row names: one, a list, or comma-separated, as Better Auth reads them. */
const rolesIn = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .filter((role): role is string => typeof role === "string")
    .flatMap((role) => role.split(","))
    .map((role) => role.trim());

/** The roles of the member a request is about: by id, or by its user's email for a removal. */
async function targetRoles(db: D1Database, org: string, member: unknown): Promise<string[]> {
  if (typeof member !== "string") return [];
  const row = member.includes("@")
    ? await db
        .prepare(
          `SELECT m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?1 AND lower(u.email) = lower(?2)`,
        )
        .bind(org, member)
        .first<{ role: string }>()
    : await db
        .prepare(`SELECT role FROM member WHERE organizationId = ?1 AND id = ?2`)
        .bind(org, member)
        .first<{ role: string }>();
  return rolesIn(row?.role);
}

/**
 * Making or unmaking an owner (ManageOwners): an invitation as one, a move to
 * or from owner, or an owner's removal. Better Auth's access control can't say
 * which role a change sets, so Keel decides these here, by the same policy as
 * every other action, before Better Auth sees them. A caller who isn't a
 * member is left to Better Auth's own refusal.
 */
async function ownerChange(ctx: HookContext, db: D1Database): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (session === null) return;
  const body: Record<string, unknown> = ctx.body ?? {};
  // The org Better Auth will act on: the one named, or else the session's active one.
  const named = body["organizationId"];
  const org =
    typeof named === "string" && named !== "" ? named : session.session.activeOrganizationId;
  if (typeof org !== "string" || org === "") return;
  const touched = [
    ...(ctx.path === "/organization/remove-member" ? [] : rolesIn(body["role"])),
    ...(await targetRoles(db, org, body["memberId"] ?? body["memberIdOrEmail"])),
  ];
  if (!touched.includes("owner")) return;
  const caller = await db
    .prepare(`SELECT role FROM member WHERE organizationId = ?1 AND userId = ?2`)
    .bind(org, session.user.id)
    .first<{ role: string }>();
  const role = strongestRole(rolesIn(caller?.role));
  if (role === undefined) return;
  const decided = decideAsRole(role, "ManageOwners");
  if (Result.isSuccess(decided)) return;
  throw new APIError("FORBIDDEN", {
    code: "OWNERS_ONLY",
    message: "Only an owner makes or unmakes an owner, or invites one",
    nextActions: "nextActions" in decided.failure ? decided.failure.nextActions : [],
  });
}

/** Runs before Better Auth's org routes. */
export function orgBefore(db: D1Database) {
  return async (ctx: HookContext) => {
    switch (ctx.path) {
      case "/organization/invite-member":
        await ownerChange(ctx, db);
        return inviteTarget(ctx, db);
      case "/organization/update-member-role":
      case "/organization/remove-member":
        return ownerChange(ctx, db);
      case "/organization/get-invitation":
        return answerable(ctx, ctx.query?.["id"]);
      case "/organization/accept-invitation":
      case "/organization/reject-invitation":
        return answerable(ctx, ctx.body?.["invitationId"]);
      case "/organization/list-user-invitations":
        return ownInvitations(ctx, db);
      default:
        return undefined;
    }
  };
}

/** Rewrites every org answer for its reader, and gives the last owner a way forward. */
export function orgAfter(db: D1Database) {
  return async (ctx: HookContext) => {
    if (!ctx.path.startsWith("/organization/")) return undefined;
    const returned: unknown = ctx.context.returned;
    if (returned instanceof APIError) {
      const code: unknown = returned.body?.code;
      if (typeof code === "string" && LAST_OWNER.has(code)) throw lastOwner(ctx.body);
      return undefined;
    }
    if (typeof returned !== "object" || returned === null || returned instanceof Response)
      return undefined;
    return ctx.json(await shown(db, returned, await readerOf(ctx, db)));
  };
}

function lastOwner(body: Record<string, unknown> | undefined): APIError {
  const org = body?.["organizationId"];
  const next: NextAction = {
    kind: "call",
    title: "Make another member an owner first",
    operationId: "ManageOwners",
    ...(typeof org === "string" ? { args: { organizationId: org } } : {}),
  };
  return new APIError("BAD_REQUEST", {
    code: "ONLY_OWNER",
    message:
      "An org always has an owner: make another member an owner before you leave or step down",
    nextActions: [next],
  });
}

async function readerOf(ctx: HookContext, db: D1Database): Promise<Reader> {
  const session = ctx.headers === undefined ? null : await getSessionFromCtx(ctx);
  if (session === null) return { manages: new Set() };
  const { results } = await db
    .prepare(`SELECT organizationId AS org, role FROM member WHERE userId = ?1`)
    .bind(session.user.id)
    .all<{ org: string; role: string }>();
  const manages = results
    .filter(({ role }) => role.split(",").some((r) => MANAGERS.has(r.trim())))
    .map(({ org }) => org);
  return {
    userId: session.user.id,
    email: session.user.email.toLowerCase(),
    manages: new Set(manages),
  };
}

/** The answer as `reader` may see it, with each member's and inviter's handle looked up. */
async function shown(
  db: D1Database,
  value: object,
  reader: Reader,
): Promise<Record<string, unknown> | unknown[]> {
  const ids = new Set<string>();
  collectUsers(value, ids);
  const { results } =
    ids.size === 0
      ? { results: [] }
      : await db
          .prepare(`SELECT id, username FROM user WHERE id IN (SELECT value FROM json_each(?1))`)
          .bind(JSON.stringify([...ids]))
          .all<{ id: string; username: string | null }>();
  const viewed = forReader(value, reader, new Map(results.map((r) => [r.id, r.username])));
  // An object or array in, the same kind out.
  if (Array.isArray(viewed) || isRecord(viewed)) return viewed;
  throw new Error("an org answer changed its kind");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const isMember = (
  o: Record<string, unknown>,
): o is Record<string, unknown> & {
  user: Record<string, unknown>;
} =>
  typeof o["userId"] === "string" && typeof o["organizationId"] === "string" && isRecord(o["user"]);

const isInvitation = (o: Record<string, unknown>): o is Record<string, unknown> & Invitation =>
  typeof o["inviterId"] === "string" &&
  typeof o["organizationId"] === "string" &&
  typeof o["status"] === "string" &&
  typeof o["email"] === "string";

function collectUsers(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) return value.forEach((v) => collectUsers(v, ids));
  if (!isRecord(value)) return;
  if (isMember(value) && typeof value.user["id"] === "string") ids.add(value.user["id"]);
  if (isInvitation(value) && typeof value["inviterId"] === "string") ids.add(value["inviterId"]);
  for (const inner of Object.values(value)) collectUsers(inner, ids);
}

/**
 * Members and invitations at any depth, as `reader` may see them: a member's
 * user carries its handle, and its email only for the reader's own; an
 * invitation by handle carries no email, and one typed by email shows it only
 * to the org's managers and its invitee; the inviter is named by handle.
 */
export function forReader(
  value: unknown,
  reader: Reader,
  handles: ReadonlyMap<string, string | null>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => forReader(v, reader, handles));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, forReader(inner, reader, handles)]),
  );
  if (isMember(value)) {
    const { email, ...user } = value.user;
    const id = typeof user["id"] === "string" ? user["id"] : "";
    out["user"] = {
      ...user,
      username: handles.get(id) ?? null,
      ...(id === reader.userId ? { email } : {}),
    };
  }
  if (isInvitation(value)) {
    const shows =
      !byHandle(value) &&
      (reader.manages.has(value.organizationId) || reader.email === value.email.toLowerCase());
    if (!shows) delete out["email"];
    if ("inviterEmail" in out) {
      delete out["inviterEmail"];
      out["inviterHandle"] = handles.get(String(value["inviterId"])) ?? null;
    }
  }
  return out;
}
