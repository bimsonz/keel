import { sha256Hex } from "../crypto.ts";
import type { Deps } from "../deps.ts";
import type { SessionRecord, UserRecord } from "../store/types.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";

/** How long a session lasts after login. There is no sliding renewal. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface IssuedSession {
  /** The bearer token. It is returned once and only its hash is stored. */
  readonly token: string;
  readonly session: SessionRecord;
  readonly user: UserRecord;
}

export type TokenResolution =
  | { readonly status: "active"; readonly session: SessionRecord; readonly user: UserRecord }
  | { readonly status: "expired"; readonly session: SessionRecord }
  | { readonly status: "unknown" };

/** Checks credentials and opens a session, or returns undefined if they are wrong. */
export async function login(deps: Deps, username: string, password: string): Promise<IssuedSession | undefined> {
  const user = deps.store.findUserByUsername(username);
  if (user === undefined) {
    // Spend the same work as a real check, so timing does not reveal which usernames exist.
    await hashPassword(password, "no-such-user");
    return undefined;
  }
  if (!(await verifyPassword(password, user.passwordSalt, user.passwordHash))) return undefined;

  const token = deps.ids.secret();
  const now = deps.clock.now();
  const session: SessionRecord = {
    id: deps.ids.id("ses"),
    userId: user.id,
    tokenHash: await sha256Hex(token),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  deps.store.createSession(session);
  return { token, session, user };
}

export function logout(deps: Deps, session: SessionRecord): void {
  deps.store.deleteSession(session.id, deps.clock.now());
}

/** Finds the session behind a bearer token and checks it against the clock. */
export async function resolveToken(deps: Deps, token: string): Promise<TokenResolution> {
  const session = deps.store.findSessionByTokenHash(await sha256Hex(token));
  if (session === undefined) return { status: "unknown" };
  if (deps.clock.now() >= session.expiresAt) return { status: "expired", session };
  const user = deps.store.getUser(session.userId);
  if (user === undefined) return { status: "unknown" };
  return { status: "active", session, user };
}
