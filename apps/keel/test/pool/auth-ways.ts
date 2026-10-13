/**
 * Sessions and passkeys as the auth pool tests handle them: how a request
 * carries a session, what a refusal for want of a fresh sign-in looks like,
 * and the steps of adding a passkey or logging keeltown in.
 */
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { type Answer, Authenticator, Jar, SESSION_COOKIE } from "./auth-harness.ts";
import { answered, site } from "./auth-users.ts";

export const tokenOf = (jar: Jar) =>
  decodeURIComponent(jar.cookies.get(SESSION_COOKIE) ?? "").split(".")[0] ?? "";

/** The jar's session as a bearer: its token, as the cookie carries it before its signature. */
export const bearerOf = (jar: Jar) => ({ authorization: `Bearer ${tokenOf(jar)}` });

/**
 * What carries a session on a request: its cookie, or its token as a bearer
 * beside a jar that holds a passkey ceremony's challenge and nothing else.
 */
export interface Carried {
  readonly jar: Jar;
  readonly headers?: Record<string, string>;
}
export const byCookie = (session: Jar): Carried => ({ jar: session });
export const byBearer = (session: Jar): Carried => ({ jar: new Jar(), headers: bearerOf(session) });

/** The way forward an account that holds a passkey is told: sign in with it again. */
export const WITH_PASSKEY = /sign in again with your passkey/i;
/** The way forward for an account with no passkey that asked to add its first: any sign-in of its own. */
export const SIGN_IN_AGAIN = /sign in again, then retry: adding your first passkey/i;
/** The way forward for an account with no passkey that asked for any other change. */
export const PASSKEY_FIRST = /add a passkey first/i;

/** Refused for want of a fresh sign-in, and told the way forward. */
export function stale(answer: Answer, way: RegExp = WITH_PASSKEY) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    403,
    "FRESH_SIGN_IN_REQUIRED",
    expect.stringMatching(way),
  ]);
}

/** Sets a session's row back in D1, as if it had been signed in `minutes` ago. */
export async function aged(session: Jar, minutes: number) {
  const made = new Date(Date.now() - minutes * 60_000).toISOString();
  const { meta } = await env.DB.prepare(`UPDATE session SET createdAt = ?1 WHERE token = ?2`)
    .bind(made, tokenOf(session))
    .run();
  expect(meta.changes).toBe(1);
}

/** How a session's row in D1 says it was signed in. */
export const signedInBy = async (token: string) =>
  (
    await env.DB.prepare(`SELECT signedInBy FROM session WHERE token = ?1`)
      .bind(token)
      .first<{ signedInBy: string | null }>()
  )?.signedInBy;

/** How many passkeys the user with a handle has. */
export const passkeysOf = async (handle: string) =>
  (
    await env.DB.prepare(
      `SELECT count(*) AS n FROM passkey p JOIN user u ON u.id = p.userId WHERE u.username = ?1`,
    )
      .bind(handle)
      .first<{ n: number }>()
  )?.n;

/** The first step of adding a passkey to a session's account: the options, with their challenge. */
export const passkeyOptions = (by: Carried, via = site) =>
  via("/passkey/generate-register-options", by);

/** The second step: a new credential, made against a challenge. */
export const registerPasskey = async (by: Carried, challenge: string, via = site) =>
  via("/passkey/verify-registration", {
    body: { response: await new Authenticator().create(challenge) },
    ...by,
  });

/** Signs in with a passkey already registered, answering the new session's jar. */
export async function signInByPasskey(device: Authenticator) {
  const jar = new Jar();
  const challenge = await site("/passkey/generate-authenticate-options", { jar });
  answered(challenge, 200);
  const asserted = await site("/passkey/verify-authentication", {
    body: { response: await device.get(challenge.json.challenge) },
    jar,
  });
  answered(asserted, 200);
  return jar;
}

/** `keeltown login`: a device grant the jar's session approves, then the code's own token. */
export async function keeltownLogin(jar: Jar) {
  const code = await site("/device/code", { body: { client_id: "keeltown" } });
  answered(code, 200);
  const claimed = await site(`/device?user_code=${encodeURIComponent(code.json.user_code)}`, {
    jar,
  });
  answered(claimed, 200);
  const approved = await site("/device/approve", { body: { userCode: code.json.user_code }, jar });
  answered(approved, 200);
  // RFC 8628: poll no faster than the interval the server named.
  await new Promise((resolve) => setTimeout(resolve, (code.json.interval ?? 5) * 1000 + 250));
  const token = await site("/device/token", {
    body: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.json.device_code,
      client_id: "keeltown",
    },
  });
  answered(token, 200);
  return { code, token };
}

/**
 * Better Auth's other routes that add or remove a way into an account, each
 * with a body its handler would take. The passkey to delete is filled in by the test.
 */
export const WAYS_IN = (passkeyId: string): [path: string, body: unknown][] => [
  ["/passkey/delete-passkey", { id: passkeyId }],
  ["/link-social", { provider: "github" }],
  ["/unlink-account", { accountId: "none" }],
  ["/change-email", { newEmail: "moved@example.com" }],
  ["/email-otp/request-email-change", { newEmail: "moved@example.com" }],
  ["/email-otp/change-email", { newEmail: "moved@example.com", otp: "000000" }],
];
