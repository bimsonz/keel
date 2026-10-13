import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authOptions, DISABLED_PATHS } from "../../src/adapters/driven/better-auth/auth.ts";
import { type Answer, type Jar } from "./auth-harness.ts";
import { answered, call, handled, signUpByCode, signUpByPasskey, site } from "./auth-users.ts";
import {
  aged,
  bearerOf,
  byBearer,
  byCookie,
  type Carried,
  keeltownLogin,
  PASSKEY_FIRST,
  passkeyOptions,
  passkeysOf,
  registerPasskey,
  SIGN_IN_AGAIN,
  signedInBy,
  stale,
  tokenOf,
  WAYS_IN,
} from "./auth-ways.ts";

function refused(answer: Answer, status: number, code: string) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    status,
    code,
    expect.anything(),
  ]);
}

/** Each member's handle and role in an org, read from D1. */
async function rolesIn(organizationId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT u.username, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?1`,
  )
    .bind(organizationId)
    .all<{ username: string; role: string }>();
  return Object.fromEntries(results.map((r) => [r.username, r.role]));
}

/** Makes `handle` a member of the org with a role: the owner invites, the invitee accepts. */
async function joined(owner: Jar, organizationId: string, handle: string, role: string) {
  const { jar } = await signUpByPasskey(handle);
  const invited = await call("/organization/invite-member", {
    body: { organizationId, role, handle },
    jar: owner,
  });
  answered(invited, 200);
  answered(
    await call("/organization/accept-invitation", {
      body: { invitationId: invited.json.id },
      jar,
    }),
    200,
  );
  const member = await env.DB.prepare(
    `SELECT id FROM member WHERE organizationId = ?1 AND userId = (SELECT id FROM user WHERE username = ?2)`,
  )
    .bind(organizationId, handle)
    .first<{ id: string }>();
  if (member === null) throw new Error(`${handle} did not join`);
  return { jar, memberId: member.id };
}

/** A bearer's session with someone else's session cookie riding beside it. */
const beside = (bearer: Jar, cookie: Jar): Carried => ({ jar: cookie, headers: bearerOf(bearer) });

/**
 * Every route of Better Auth's that takes, sets, checks or resets a password,
 * with its account deletion, which asks for one: named here apart from the
 * list Keel disables, so a path that leaves that list is still asked for.
 */
const PASSWORD_ROUTES = [
  "/sign-in/email",
  "/sign-up/email",
  "/sign-in/username",
  "/change-password",
  "/verify-password",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/abc",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/forget-password/email-otp",
  "/delete-user",
  "/delete-user/callback",
];

/**
 * A request to a path Keel does not serve, as each method would ask it, of
 * keel.town as deployed and of the same app with a mail sender: Better Auth
 * mounts the email code's routes only with one.
 */
const asked = (path: string, by: { jar?: Jar }) =>
  Promise.all([
    site(path, by),
    site(path, { body: {}, ...by }),
    call(path, by),
    call(path, { body: {}, ...by }),
  ]);

describe("one credential a request, at /v1/auth", () => {
  it("[ba.one-credential] a request that presents a bearer is that bearer's alone, whatever cookie rides beside it", async () => {
    const owner = await signUpByPasskey("oda");
    const made = await call("/organization/create", {
      body: { name: "oak", slug: "oak" },
      jar: owner.jar,
    });
    answered(made, 200);
    const oak: string = made.json.id;
    const maintainer = await joined(owner.jar, oak, "moe", "maintainer");
    const member = await joined(owner.jar, oak, "mia", "member");
    const bare = await signUpByCode("bare@example.com");

    // Who a session read answers for.
    const read = await call("/get-session", beside(owner.jar, maintainer.jar));
    expect(read.json.user.username).toBe("oda");

    // An owner change: the maintainer's bearer is refused though the owner's cookie rides beside it,
    // and the owner's bearer makes an owner though a maintainer's cookie does.
    const toOwner = { organizationId: oak, memberId: member.memberId, role: "owner" };
    refused(
      await call("/organization/update-member-role", {
        body: toOwner,
        ...beside(maintainer.jar, owner.jar),
      }),
      403,
      "OWNERS_ONLY",
    );
    expect(await rolesIn(oak)).toEqual({ oda: "owner", moe: "maintainer", mia: "member" });
    answered(
      await call("/organization/update-member-role", {
        body: toOwner,
        ...beside(owner.jar, maintainer.jar),
      }),
      200,
    );
    expect(await rolesIn(oak)).toEqual({ oda: "owner", moe: "maintainer", mia: "owner" });

    // The handle: a bearer with none is told to choose one, whoever's cookie is beside it,
    // and a bearer with one makes its own org beside a cookie with none.
    refused(
      await call("/organization/create", {
        body: { name: "ash", slug: "ash" },
        ...beside(bare.jar, owner.jar),
      }),
      403,
      "HANDLE_REQUIRED",
    );
    expect(
      await env.DB.prepare(`SELECT 1 FROM organization WHERE slug = 'ash'`).first(),
    ).toBeNull();
    const own = await call("/organization/create", {
      body: { name: "elm", slug: "elm" },
      ...beside(owner.jar, bare.jar),
    });
    answered(own, 200);
    expect(await rolesIn(own.json.id)).toEqual({ oda: "owner" });
  });

  it("[ba.one-credential-fresh] a fresh sign-in is asked of the bearer a request presents, and of no cookie beside it", async () => {
    const mine = await signUpByPasskey("jay");
    const other = await signUpByPasskey("jem");
    await aged(other.jar, 11);

    // A fresh bearer beside a stale cookie: the passkey lands on the bearer's account alone.
    const fresh = beside(mine.jar, other.jar);
    const options = await passkeyOptions(fresh, call);
    answered(options, 200);
    answered(await registerPasskey(fresh, options.json.challenge, call), 200);
    expect([await passkeysOf("jay"), await passkeysOf("jem")]).toEqual([2, 1]);

    // A stale bearer beside a fresh cookie is refused every way in.
    const old = beside(other.jar, mine.jar);
    stale(await passkeyOptions(old, call));
    stale(await registerPasskey(old, "none", call));
    for (const [path, body] of WAYS_IN("none")) stale(await call(path, { body, ...old }));
    expect([await passkeysOf("jay"), await passkeysOf("jem")]).toEqual([2, 1]);
  });
});

/** Signs up by email code, adds a first passkey while the sign-in is fresh, and is refused a second. */
async function addsItsFirst(handle: string, carry: (session: Jar) => Carried) {
  const coded = await handled(`${handle}@example.com`, handle);
  expect(await signedInBy(tokenOf(coded.jar))).toBe("email-otp");
  expect(await passkeysOf(handle)).toBe(0);
  const by = carry(coded.jar);
  const options = await passkeyOptions(by, call);
  answered(options, 200);
  answered(await registerPasskey(by, options.json.challenge, call), 200);
  expect(await passkeysOf(handle)).toBe(1);

  // It holds a passkey now, so only a passkey's session adds or removes a way in.
  stale(await passkeyOptions(by, call));
  stale(await registerPasskey(by, "none", call));
  return passkeysOf(handle);
}

describe("an account's first passkey", () => {
  it("[ba.first-passkey] by cookie: an account with no passkey adds its first with its own sign-in from the last ten minutes", async () => {
    expect(await addsItsFirst("fern", byCookie)).toBe(1);
  });

  it("[ba.first-passkey] by bearer: an account with no passkey adds its first with its own sign-in from the last ten minutes", async () => {
    expect(await addsItsFirst("faye", byBearer)).toBe(1);
  });

  it("[ba.first-passkey-age] a sign-in older than ten minutes adds no first passkey, at either step", async () => {
    const coded = await handled("flo@example.com", "flo");
    const held = await passkeyOptions(byCookie(coded.jar), call);
    answered(held, 200);
    await aged(coded.jar, 11);
    stale(await passkeyOptions(byCookie(coded.jar), call), SIGN_IN_AGAIN);
    stale(await registerPasskey(byCookie(coded.jar), held.json.challenge, call), SIGN_IN_AGAIN);
    stale(await passkeyOptions(byBearer(coded.jar), call), SIGN_IN_AGAIN);
    expect(await passkeysOf("flo")).toBe(0);
  });

  it("[ba.first-passkey-own] a session the person did not sign in themselves adds no first passkey", async () => {
    // keeltown's session: any session of the account approves it, at any age.
    const coded = await handled("dot@example.com", "dot");
    const { token } = await keeltownLogin(coded.jar);
    const device: Carried = {
      ...byBearer(coded.jar),
      headers: { authorization: `Bearer ${token.json.access_token}` },
    };
    expect(await signedInBy(token.json.access_token)).toBe("device");
    stale(await passkeyOptions(device, call), SIGN_IN_AGAIN);
    stale(await registerPasskey(device, "none", call), SIGN_IN_AGAIN);

    // A session from before its sign-in was recorded says no way at all.
    const { meta } = await env.DB.prepare(`UPDATE session SET signedInBy = NULL WHERE token = ?1`)
      .bind(tokenOf(coded.jar))
      .run();
    expect(meta.changes).toBe(1);
    stale(await passkeyOptions(byCookie(coded.jar), call), SIGN_IN_AGAIN);
    expect(await passkeysOf("dot")).toBe(0);
  }, 30_000);

  it("[ba.first-passkey-routes] with no passkey, every other way in still waits for one", async () => {
    const coded = await handled("gia@example.com", "gia");
    for (const [path, body] of WAYS_IN("none")) {
      stale(await call(path, { body, jar: coded.jar }), PASSKEY_FIRST);
      stale(await call(path, { body, headers: bearerOf(coded.jar) }), PASSKEY_FIRST);
    }
    expect(await passkeysOf("gia")).toBe(0);
  });
});

describe("no passwords at /v1/auth", () => {
  it("[ba.no-passwords] every route that takes, sets or resets a password answers 404, signed in or not", async () => {
    const { jar } = await signUpByPasskey("pia");
    for (const path of PASSWORD_ROUTES) {
      const answers = [...(await asked(path, {})), ...(await asked(path, { jar }))];
      expect([path, ...answers.map((answer) => answer.status)]).toEqual([
        path,
        ...Array.from({ length: 8 }, () => 404),
      ]);
    }
    // The control: a route Keel serves is found.
    expect((await site("/get-session", { jar })).status).toBe(200);
  });

  it("[ba.no-passwords-sweep] Better Auth mounts no route that names a password outside the disabled ones", () => {
    const { auth } = authOptions({
      db: env.DB,
      secret: "s".repeat(40),
      host: env.KEEL_HOST,
      sendOtp: async () => {},
      github: { clientId: "id", clientSecret: "secret" },
    });
    const disabled: ReadonlySet<string> = new Set(DISABLED_PATHS);
    const naming: string[] = [];
    let mounted = 0;
    for (const endpoint of Object.values<unknown>(auth.api)) {
      const path: unknown = Reflect.get(Object(endpoint), "path");
      if (typeof path !== "string") continue;
      mounted += 1;
      const body: unknown = Reflect.get(Object(Reflect.get(Object(endpoint), "options")), "body");
      const fields = Object.keys(Object(Reflect.get(Object(body), "shape")));
      if (/password/i.test(path) || fields.some((field) => /password/i.test(field)))
        naming.push(path);
    }
    expect(mounted).toBeGreaterThan(50);
    expect(naming.length).toBeGreaterThan(8);
    expect(naming.filter((path) => !disabled.has(path))).toEqual([]);
  });
});
