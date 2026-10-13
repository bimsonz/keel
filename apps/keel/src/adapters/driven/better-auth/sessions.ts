/**
 * A person's own sessions: the list of them, and ending one. Better Auth's own
 * pair is not served (`DISABLED_PATHS` in auth.ts): its list answers every
 * session's token, which signs in as the person, and refuses a session older
 * than a day; its revoke takes a token. Here a session is named by its row's
 * id, which signs nothing in, and the list reads the columns it answers and no
 * other.
 *
 * Ending a session asks for no fresh sign-in (fresh.ts): it changes nothing
 * about how the account signs in, and whoever is ended signs in again.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { Schema } from "effect";
import type { SignInMethod } from "./fresh.ts";

/**
 * How long a session is used before Better Auth writes its row again (its
 * `updateAge`): the write moves `updatedAt` and the expiry. So `lastUsedAt` is
 * a session's last use to within this, for one write an hour while it is used.
 */
export const SESSION_WRITE_SECONDS = 60 * 60;

/** The columns of a session's row the list reads: all it answers, and never the token. */
const SHOWN = ["id", "createdAt", "updatedAt", "expiresAt", "userAgent", "signedInBy"] as const;

/** What ending a session is asked with: the id the list names it by. */
const Ending = Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String }));

/** A session's row as the list reads it. */
export interface SessionRow {
  readonly id: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly expiresAt: Date | string;
  readonly userAgent?: string | null | undefined;
  readonly signedInBy?: string | null | undefined;
}

/** One session as its person is shown it. */
export interface OwnSession {
  readonly id: string;
  /** Whether this is the session that asked. */
  readonly current: boolean;
  /** How it was signed in; `device` is `keeltown login`. A row that names no way Keel knows is `other`. */
  readonly signedInBy: SignInMethod;
  /** What signed in said it was, as it was sent; null when it said nothing. */
  readonly userAgent: string | null;
  readonly createdAt: string;
  /** Its last use, to within `SESSION_WRITE_SECONDS`. */
  readonly lastUsedAt: string;
  readonly expiresAt: string;
}

const WAYS: ReadonlySet<string> = new Set<SignInMethod>([
  "passkey",
  "email-otp",
  "github",
  "device",
]);
const isWay = (by: unknown): by is SignInMethod => typeof by === "string" && WAYS.has(by);

const at = (time: Date | string): string => new Date(time).toISOString();

/** A session's row as its person is shown it, `asking` being the id of the session that asked. */
export function shownSession(row: SessionRow, asking: string): OwnSession {
  return {
    id: row.id,
    current: row.id === asking,
    signedInBy: isWay(row.signedInBy) ? row.signedInBy : "other",
    userAgent: typeof row.userAgent === "string" && row.userAgent !== "" ? row.userAgent : null,
    createdAt: at(row.createdAt),
    lastUsedAt: at(row.updatedAt),
    expiresAt: at(row.expiresAt),
  };
}

/** `GET /sessions` and `POST /sessions/revoke`, each for whoever is signed in and for their own sessions alone. */
export const ownSessions = () =>
  ({
    id: "own-sessions",
    endpoints: {
      listOwnSessions: createAuthEndpoint(
        "/sessions",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context.session;
          const rows = await ctx.context.adapter.findMany<SessionRow>({
            model: "session",
            where: [
              { field: "userId", value: session.userId },
              { field: "expiresAt", operator: "gt", value: new Date() },
            ],
            select: [...SHOWN],
            sortBy: { field: "updatedAt", direction: "desc" },
          });
          return ctx.json({ sessions: rows.map((row) => shownSession(row, session.id)) });
        },
      ),
      revokeOwnSession: createAuthEndpoint(
        "/sessions/revoke",
        { method: "POST", body: Ending, use: [sessionMiddleware] },
        async (ctx) => {
          const ended = await ctx.context.adapter.deleteMany({
            model: "session",
            where: [
              { field: "id", value: ctx.body.id },
              { field: "userId", value: ctx.context.session.session.userId },
            ],
          });
          // One answer for a session that is someone else's and one that was never there.
          if (ended === 0)
            throw APIError.from("NOT_FOUND", {
              code: "SESSION_NOT_FOUND",
              message: "No session of yours has that id",
            });
          return ctx.json({ ended: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
