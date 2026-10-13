import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it, vi } from "vitest";
import { authOptions } from "../../src/adapters/driven/better-auth/auth.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { type Answer, caller, Jar, SESSION_COOKIE } from "./auth-harness.ts";
import {
  answered,
  call,
  handled,
  outbox,
  signUpByCode,
  signUpByPasskey,
  site,
} from "./auth-users.ts";
import {
  aged,
  bearerOf,
  byBearer,
  byCookie,
  type Carried,
  keeltownLogin,
  passkeyOptions,
  passkeysOf,
  registerPasskey,
  signedInBy,
  signInByPasskey,
  stale,
  tokenOf,
  WAYS_IN,
} from "./auth-ways.ts";

function holdsNoToken(answer: Answer, token: string) {
  expect(token.length).toBeGreaterThan(16);
  expect(answer.text).not.toContain(token);
  expect(answer.text).not.toMatch(/"token"\s*:/);
  expect(answer.headers.get("set-auth-token")).toBeNull();
}

const from = (ip: string) => ({ body: {}, headers: { "cf-connecting-ip": ip } });

/** What a user's GitHub account row holds of GitHub's tokens. */
const githubTokens = async (userId: string) =>
  (
    await env.DB.prepare(
      `SELECT accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt FROM account WHERE providerId = 'github' AND userId = ?1`,
    )
      .bind(userId)
      .all()
  ).results;

/**
 * Adds a passkey with a session a moment old, is refused once the session is
 * eleven minutes old, and adds one again after signing in afresh. Answers how
 * many passkeys the account ends with.
 */
async function addsPasskeysOnlyWhileFresh(handle: string, carry: (session: Jar) => Carried) {
  // Passkey-first sign-up carries no session, and stays as it was.
  const { jar, device } = await signUpByPasskey(handle);
  const first = carry(jar);
  const options = await passkeyOptions(first);
  answered(options, 200);
  answered(await registerPasskey(first, options.json.challenge), 200);
  expect(await passkeysOf(handle)).toBe(2);
  expect(first.jar.cookies.has(SESSION_COOKIE)).toBe(first.headers === undefined);

  // Eleven minutes on, neither step: not the options, and not a challenge taken while fresh.
  const held = await passkeyOptions(first);
  answered(held, 200);
  await aged(jar, 11);
  stale(await passkeyOptions(first));
  stale(await registerPasskey(first, held.json.challenge));
  expect(await passkeysOf(handle)).toBe(2);

  // Signing in again with the first passkey makes a session that may; the old one still may not.
  const again = carry(await signInByPasskey(device));
  const renewed = await passkeyOptions(again);
  answered(renewed, 200);
  answered(await registerPasskey(again, renewed.json.challenge), 200);
  stale(await passkeyOptions(first));
  return passkeysOf(handle);
}

describe("Better Auth at /v1/auth", () => {
  it("[ba.schema] migration 0006 holds every table and column Keel's auth options need", async () => {
    const { options } = authOptions({
      db: env.DB,
      secret: env.BETTER_AUTH_SECRET,
      host: env.KEEL_HOST,
      sendOtp: async () => {},
      github: { clientId: "id", clientSecret: "secret" },
    });
    const { toBeCreated, toBeAdded } = await getMigrations(options);
    expect(toBeCreated.map((t) => t.table)).toEqual([]);
    expect(toBeAdded.map((t) => [t.table, Object.keys(t.fields)])).toEqual([]);
  });

  it("[ba.mount] keel.town's entry serves Better Auth, and offers no email codes without a sender", async () => {
    const ok = await site("/ok");
    expect(ok.status).toBe(200);
    const send = await site("/email-otp/send-verification-otp", {
      body: { email: "nobody@example.com", type: "sign-in" },
    });
    expect(send.status).toBe(404);
  });

  it("[auth.methods] answers only the sign-in methods mounted, a passkey always being one", async () => {
    const bare = await site("/methods");
    answered(bare, 200);
    expect(bare.json).toEqual({ emailCode: false, github: false });
    expect((await call("/methods")).json).toEqual({ emailCode: true, github: false });
    // GitHub's secrets are optional, so Env doesn't declare them.
    const githubEnv: Env & { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string } = {
      ...env,
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    };
    const withGithub = makeIsolate(githubEnv, isolateLayer(env));
    const viaGithub = caller(async (request) =>
      withGithub.app.fetch(request, env, createExecutionContext()),
    );
    expect((await viaGithub("/methods")).json).toEqual({ emailCode: false, github: true });
  });

  it("[ba.github-no-token] signs in with GitHub and keeps none of GitHub's tokens, at sign-up or at a later sign-in", async () => {
    const githubEnv: Env & { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string } = {
      ...env,
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    };
    const withGithub = makeIsolate(githubEnv, isolateLayer(env));
    const viaGithub = caller(async (request) =>
      withGithub.app.fetch(request, env, createExecutionContext()),
    );
    // GitHub, as Better Auth's provider calls it: the token exchange, then the profile and its emails.
    const asked: string[] = [];
    const strays: string[] = [];
    const github = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const at = `${request.method} ${request.url.split("?")[0]}`;
      asked.push(at);
      switch (at) {
        case "POST https://github.com/login/oauth/access_token":
          return Response.json({
            access_token: "gho_access",
            refresh_token: "ghr_refresh",
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        case "GET https://api.github.com/user":
          return Response.json({ id: 4242, login: "octo", name: "Octo", email: null });
        case "GET https://api.github.com/user/emails":
          return Response.json([{ email: "octo@example.com", primary: true, verified: true }]);
        default:
          strays.push(at);
          throw new Error(`no fetch to ${at} was expected`);
      }
    });
    const signIn = async () => {
      const jar = new Jar();
      const started = await viaGithub("/sign-in/social", {
        body: { provider: "github", callbackURL: "/" },
        jar,
      });
      answered(started, 200);
      const authorize = new URL(started.json.url);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(
        "https://github.com/login/oauth/authorize",
      );
      const state = authorize.searchParams.get("state") ?? "";
      const back = await viaGithub(`/callback/github?code=x&state=${encodeURIComponent(state)}`, {
        jar,
      });
      expect([back.status, back.headers.get("location")]).toEqual([302, "/"]);
      const session = await viaGithub("/get-session", { jar });
      answered(session, 200);
      expect(session.json.user.email).toBe("octo@example.com");
      return String(session.json.user.id);
    };
    const none = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    };
    try {
      const userId = await signIn();
      expect(await githubTokens(userId)).toEqual([none]);
      // Signing in again updates the same account, and keeps no token either.
      expect(await signIn()).toBe(userId);
      expect(await githubTokens(userId)).toEqual([none]);
      expect(asked.filter((at) => at.includes("access_token"))).toHaveLength(2);
      expect(strays).toEqual([]);
    } finally {
      github.mockRestore();
    }
  });

  it("[ba.cookie] keeps the session in a __Secure-, HttpOnly, SameSite=Lax cookie for the whole site", async () => {
    const { jar } = await signUpByCode("cookie@example.com");
    const line = jar.lines.find((l) => l.startsWith(`${SESSION_COOKIE}=`));
    expect(line).toBeDefined();
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\//i);
  });

  it("[ba.no-token] answers never carry the session's token, and no set-auth-token header", async () => {
    const { jar, signed } = await signUpByCode("tokens@example.com");
    const token = tokenOf(jar);
    holdsNoToken(signed, token);
    expect(signed.json.user.email).toBe("tokens@example.com");
    const session = await call("/get-session", { jar });
    holdsNoToken(session, token);
    expect(session.json.session.userId).toBe(session.json.user.id);
  });

  it("[ba.cross-site] refuses a cookie-carrying write from another site, and takes the same from keel.town, even where the environment looks like a test runner's", async () => {
    // Better Auth skips its origin check when NODE_ENV is test or TEST is set, and
    // nodejs_compat puts a Worker's vars in process.env, so one stray var would turn
    // it off. Keel sets the check on explicitly; this case runs where the default is off.
    const runner = globalThis.process.env;
    runner["TEST"] = "true";
    try {
      const isolate = makeIsolate(env, isolateLayer(env), {
        sendOtp: async (message) => {
          outbox.push(message);
        },
      });
      const viaRunner = caller(async (request) =>
        isolate.app.fetch(request, env, createExecutionContext()),
      );
      const { jar } = await signUpByCode("csrf@example.com", viaRunner);
      const forged = await viaRunner("/update-user", {
        body: { username: "csrf" },
        jar,
        origin: "https://evil.example",
      });
      answered(forged, 403);
      const unchanged = await viaRunner("/get-session", { jar });
      expect(unchanged.json.user.username).toBeNull();
      const own = await viaRunner("/update-user", { body: { username: "csrf" }, jar });
      answered(own, 200);
    } finally {
      delete runner["TEST"];
    }
  });

  it("[ba.handle-first] a user without a handle may only choose one or sign out; the handle makes its personal org", async () => {
    const { jar, userId } = await signUpByCode("first@example.com");
    const org = await call("/organization/create", { body: { name: "Mine", slug: "mine" }, jar });
    answered(org, 403);
    expect(org.json.code).toBe("HANDLE_REQUIRED");
    const listed = await call("/organization/list", { jar });
    expect(listed.status).toBe(403);
    const named = await call("/update-user", { body: { name: "Ada" }, jar });
    expect(named.status).toBe(400);
    expect(named.json.code).toBe("HANDLE_REQUIRED");

    const set = await call("/update-user", { body: { username: "First" }, jar });
    answered(set, 200);
    const orgs = await call("/organization/list", { jar });
    answered(orgs, 200);
    expect(orgs.json.map((o: { slug: string }) => o.slug)).toEqual(["first"]);
    expect(orgs.json[0].id).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
    const full = await call("/organization/get-full-organization?organizationSlug=first", { jar });
    expect(full.json.members).toEqual([expect.objectContaining({ userId, role: "owner" })]);
    expect(userId).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("[ba.handle-immutable] a handle, once chosen, never changes", async () => {
    const { jar } = await handled("fixed@example.com", "fixed");
    const again = await call("/update-user", { body: { username: "moved" }, jar });
    answered(again, 400);
    const session = await call("/get-session", { jar });
    expect(session.json.user.username).toBe("fixed");
  });

  it("[ba.names] handles and org names are one namespace, keel.town's own paths refused in any case", async () => {
    const ada = await handled("ada@example.com", "ada");
    const bea = await signUpByCode("bea@example.com");

    const reserved = await call("/update-user", { body: { username: "Admin" }, jar: bea.jar });
    expect(reserved.status).toBe(400);
    expect(reserved.json.code).toBe("NAME_REFUSED");
    const taken = await call("/update-user", { body: { username: "ada" }, jar: bea.jar });
    expect(taken.status).toBe(400);

    const acme = await call("/organization/create", {
      body: { name: "Acme", slug: "acme" },
      jar: ada.jar,
    });
    answered(acme, 200);
    // The org for Keel's own projects is an ordinary name: whoever asks first takes it.
    answered(
      await call("/organization/create", { body: { name: "Keel", slug: "keel" }, jar: ada.jar }),
      200,
    );
    const instance = await call("/update-user", { body: { username: "Keel" }, jar: bea.jar });
    expect([instance.status, instance.json.code]).toEqual([400, "NAME_TAKEN"]);
    const orgName = await call("/update-user", { body: { username: "acme" }, jar: bea.jar });
    expect(orgName.status).toBe(400);
    expect(orgName.json.code).toBe("NAME_TAKEN");
    expect((await call("/update-user", { body: { username: "bea" }, jar: bea.jar })).status).toBe(
      200,
    );

    // Bea's handle made her personal org, so the name is taken twice over.
    const handle = await call("/organization/create", {
      body: { name: "Bea", slug: "bea" },
      jar: ada.jar,
    });
    expect(handle.status).toBe(400);
    const path = await call("/organization/create", {
      body: { name: "S", slug: "Settings" },
      jar: ada.jar,
    });
    expect(path.status).toBe(400);
    expect(path.json.code).toBe("NAME_REFUSED");

    const renamed = await call("/organization/update", {
      body: { organizationId: acme.json.id, data: { slug: "acme2" } },
      jar: ada.jar,
    });
    expect(renamed.status).toBe(400);
    expect(renamed.json.code).toBe("NAME_IMMUTABLE");
    const personal = (await call("/organization/list", { jar: ada.jar })).json.find(
      (o: { slug: string }) => o.slug === "ada",
    );
    const deleted = await call("/organization/delete", {
      body: { organizationId: personal.id },
      jar: ada.jar,
    });
    expect(deleted.status).toBe(400);
    expect(deleted.json.code).toBe("PERSONAL_ORG");
  });

  it("[ba.passkey-first] signs up with a handle and a passkey alone, then signs in with the passkey", async () => {
    const { jar, device, registered } = await signUpByPasskey("Cy");
    holdsNoToken(registered, tokenOf(jar));
    const session = await site("/get-session", { jar });
    expect(session.json.user).toMatchObject({
      username: "cy",
      email: "cy@users.keel.invalid",
      emailVerified: false,
    });
    const orgs = await site("/organization/list", { jar });
    expect(orgs.json.map((o: { slug: string }) => o.slug)).toEqual(["cy"]);

    const fresh = new Jar();
    const challenge = await site("/passkey/generate-authenticate-options", { jar: fresh });
    const asserted = await site("/passkey/verify-authentication", {
      body: { response: await device.get(challenge.json.challenge) },
      jar: fresh,
    });
    answered(asserted, 200);
    expect((await site("/get-session", { jar: fresh })).json.user.id).toBe(session.json.user.id);

    const taken = await site("/passkey/generate-register-options?context=cy", { jar: new Jar() });
    expect(taken.status).toBe(400);
    expect(taken.json.code).toBe("NAME_TAKEN");
    const path = await site("/passkey/generate-register-options?context=login", { jar: new Jar() });
    expect(path.status).toBe(400);
    expect(path.json.code).toBe("NAME_REFUSED");
  });

  it("[ba.placeholder] never sends a code to an address that can't receive mail", async () => {
    await signUpByPasskey("dee");
    const before = outbox.length;
    // Better Auth answers alike whatever the address, and sends in the background.
    const sent = await call("/email-otp/send-verification-otp", {
      body: { email: "dee@users.keel.invalid", type: "sign-in" },
    });
    expect(sent.status).toBe(200);
    const control = await call("/email-otp/send-verification-otp", {
      body: { email: "dee@example.com", type: "sign-in" },
    });
    expect(control.status).toBe(200);
    await expect.poll(() => outbox.slice(before).map((m) => m.to)).toEqual(["dee@example.com"]);
  });

  it("[ba.device] logs keeltown in by the device grant; its token reads the session as a bearer", async () => {
    const { jar } = await signUpByPasskey("eve");
    const stranger = await site("/device/code", { body: { client_id: "other-cli" } });
    expect(stranger.status).toBe(400);

    const { code, token } = await keeltownLogin(jar);
    expect(code.json.verification_uri).toBe(`https://${env.KEEL_HOST}/device`);
    expect(token.json.access_token).toEqual(expect.any(String));
    const bearer = await site("/get-session", {
      headers: { authorization: `Bearer ${token.json.access_token}` },
      origin: null,
    });
    expect(bearer.json.user.username).toBe("eve");
    holdsNoToken(bearer, token.json.access_token);
  }, 30_000);

  it("[ba.fresh-sign-in] by cookie: a session adds a passkey only within ten minutes of its own passkey sign-in", async () => {
    // The one it signed up with, one while fresh, and one after signing in again.
    expect(await addsPasskeysOnlyWhileFresh("gail", byCookie)).toBe(3);
  });

  it("[ba.fresh-sign-in] by bearer: a session adds a passkey only within ten minutes of its own passkey sign-in", async () => {
    expect(await addsPasskeysOnlyWhileFresh("gwen", byBearer)).toBe(3);
  });

  it("[ba.fresh-sign-in] a session no passkey signed in adds none to an account that holds one, though it is seconds old", async () => {
    // keeltown's own, by bearer: the device grant's, though a fresh passkey session approved it.
    const { jar } = await signUpByPasskey("gus");
    const { token } = await keeltownLogin(jar);
    const cli: Carried = {
      jar: new Jar(),
      headers: { authorization: `Bearer ${token.json.access_token}` },
    };
    expect(await signedInBy(token.json.access_token)).toBe("device");
    expect((await site("/get-session", cli)).json.user.username).toBe("gus");
    stale(await passkeyOptions(cli));
    stale(await registerPasskey(cli, "none"));
    // The session that approved it is a passkey's, and still may.
    answered(await passkeyOptions(byCookie(jar)), 200);

    // A session from before its sign-in was recorded says no way at all.
    const { meta } = await env.DB.prepare(`UPDATE session SET signedInBy = NULL WHERE token = ?1`)
      .bind(tokenOf(jar))
      .run();
    expect(meta.changes).toBe(1);
    stale(await passkeyOptions(byCookie(jar)));
    expect(await passkeysOf("gus")).toBe(1);
  }, 30_000);

  it("[ba.fresh-routes] every other route that adds or removes a way in refuses a session that isn't fresh", async () => {
    const { jar } = await signUpByPasskey("ivy");
    const options = await passkeyOptions(byCookie(jar));
    const spare = await registerPasskey(byCookie(jar), options.json.challenge);
    answered(spare, 200);

    // Fresh, each is left to Better Auth, which answers for its own reasons.
    for (const [path, body] of WAYS_IN("none")) {
      const answer = await call(path, { body, jar });
      expect([path, answer.json?.code]).not.toEqual([path, "FRESH_SIGN_IN_REQUIRED"]);
    }

    await aged(jar, 11);
    for (const [path, body] of WAYS_IN(spare.json.id)) {
      stale(await call(path, { body, jar }));
      stale(await call(path, { body, headers: bearerOf(jar) }));
    }
    expect(await passkeysOf("ivy")).toBe(2);
  });

  it("[ba.session-method] a session's row says how it was signed in, and no client says so for it", async () => {
    const { jar, device } = await signUpByPasskey("hal");
    expect(await signedInBy(tokenOf(jar))).toBe("passkey");
    const again = await signInByPasskey(device);
    expect(tokenOf(again)).not.toBe(tokenOf(jar));
    expect(await signedInBy(tokenOf(again))).toBe("passkey");

    // An email code's session can't call itself a passkey's.
    const coded = await handled("hope@example.com", "hope");
    expect(await signedInBy(tokenOf(coded.jar))).toBe("email-otp");
    const claimed = await call("/update-session", {
      body: { signedInBy: "passkey" },
      jar: coded.jar,
    });
    expect([claimed.status, claimed.json?.code]).toEqual([400, "FIELD_NOT_ALLOWED"]);
    expect(await signedInBy(tokenOf(coded.jar))).toBe("email-otp");
  });

  it("[ba.disabled] serves no session list: its answers would carry every session's token", async () => {
    const { jar } = await signUpByPasskey("fay");
    expect((await site("/list-sessions", { jar })).status).toBe(404);
    expect((await site("/revoke-session", { body: { token: "x" }, jar })).status).toBe(404);
    expect((await site("/revoke-other-sessions", { body: {}, jar })).status).toBe(200);
  });

  it("[ba.rate-limit] asks the limiter about each write, keyed by address, and refuses what it refuses", async () => {
    // A fixed allowance stands in for the binding's window, which a slow run could straddle.
    const asked: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        asked.push(key);
        return { success: asked.filter((k) => k === key).length <= 30 };
      },
    };
    const isolate = makeIsolate({ ...env, AUTH_LIMIT: limiter }, isolateLayer(env));
    const limited = caller(async (request) =>
      isolate.app.fetch(request, env, createExecutionContext()),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 33; i++)
      statuses.push((await limited("/sign-out", from("192.0.2.7"))).status);
    expect(statuses.slice(0, 30).filter((s) => s === 429)).toEqual([]);
    expect(statuses.slice(30)).toEqual([429, 429, 429]);
    expect((await limited("/sign-out", from("192.0.2.8"))).status).not.toBe(429);
    const read = await limited("/get-session", { headers: { "cf-connecting-ip": "192.0.2.7" } });
    expect(read.status).not.toBe(429);
    expect([...new Set(asked)]).toEqual(["auth:192.0.2.7", "auth:192.0.2.8"]);
  });
});
