import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../../src/adapters/driven/better-auth/auth.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { type Answer, Authenticator, caller, Jar } from "./auth-harness.ts";
import { answered, site } from "./auth-users.ts";

/** keel.town holding three names for its claimant, as KEEL_HELD_NAMES sets them. */
const HELD = "zed, zoe, zia";
const holding = makeIsolate({ ...env, KEEL_HELD_NAMES: HELD }, isolateLayer(env));
const held = caller(async (request) => holding.app.fetch(request, env, createExecutionContext()));

const CODE = env.TEST_CLAIM_CODE;
const WRONG = "not-the-claim-code";

/** Every answer of a claim, kept to check that none carries the code or its digest. */
const seen: Answer[] = [];

function refused(answer: Answer, status: number, code: string) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    status,
    code,
    expect.anything(),
  ]);
}

/** A passkey sign-up's first call for `handle`, presenting `claim` as Keel-Claim when given. */
async function begin(handle: string, claim?: string) {
  const jar = new Jar();
  const headers: Record<string, string> = claim === undefined ? {} : { "Keel-Claim": claim };
  const options = await held(
    `/passkey/generate-register-options?context=${encodeURIComponent(handle)}`,
    { jar, headers },
  );
  seen.push(options);
  return { jar, options };
}

/** Its second call, with a new passkey, presenting `claim` as Keel-Claim when given. */
async function finish(begun: { jar: Jar; options: Answer }, claim?: string) {
  const registered = await held("/passkey/verify-registration", {
    body: {
      response: await new Authenticator().create(begun.options.json.challenge),
      createSession: true,
    },
    jar: begun.jar,
    headers: claim === undefined ? {} : { "Keel-Claim": claim },
  });
  seen.push(registered);
  return registered;
}

/** No answer carries the code, which is the claimant's, or its digest, the Worker's secret. */
function toldNothing() {
  expect(seen.length).toBeGreaterThan(0);
  for (const answer of seen) {
    const told = `${answer.text}\n${[...answer.headers].join("\n")}`;
    expect(told.includes(CODE)).toBe(false);
    expect(told.toLowerCase().includes(env.KEEL_CLAIM_DIGEST.toLowerCase())).toBe(false);
  }
}

const rows = async <T>(sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
const admins = () => rows<{ id: string }>(`SELECT id FROM user WHERE role = 'admin'`);
const instanceOrgs = () =>
  rows<{ id: string; createdAt: unknown }>(
    `SELECT id, createdAt FROM organization WHERE slug = 'keel'`,
  );
const membersOf = (org: string) =>
  rows<{ userId: string; role: string }>(
    `SELECT userId, role FROM member WHERE organizationId = ?1`,
    org,
  );

describe("the instance claim (P3)", () => {
  // Each case claims an instance nobody has claimed: the last case's admin steps down and org keel goes.
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM organization WHERE slug = 'keel'`),
      env.DB.prepare(`UPDATE user SET role = 'user' WHERE role = 'admin'`),
    ]);
    seen.length = 0;
  });

  it("[claim.held] a held handle is refused without the code; a wrong code, or the code for a name not held, is CLAIM_INVALID, at either call", async () => {
    refused((await begin("zed")).options, 400, "NAME_REFUSED");
    refused((await begin("Zed", WRONG)).options, 403, "CLAIM_INVALID");
    refused((await begin("yan", CODE)).options, 403, "CLAIM_INVALID");

    // A passkey begun with the code finishes only with it.
    const bare = await begin("zed", CODE);
    answered(bare.options, 200);
    refused(await finish(bare), 400, "NAME_REFUSED");
    const wrong = await begin("zed", CODE);
    answered(wrong.options, 200);
    refused(await finish(wrong, WRONG), 403, "CLAIM_INVALID");

    expect(await rows(`SELECT id FROM user WHERE username = 'zed' OR email LIKE 'zed@%'`)).toEqual(
      [],
    );
    expect(await admins()).toEqual([]);
    expect(await instanceOrgs()).toEqual([]);
    toldNothing();
  });

  it("[claim.owner] the code releases a held handle to its presenter: the instance admin, the only owner of org keel, with a personal org like anyone's", async () => {
    const begun = await begin("Zed", CODE);
    answered(begun.options, 200);
    answered(await finish(begun, CODE), 200);
    toldNothing();

    const session = await held("/get-session", { jar: begun.jar });
    expect(session.json.user).toMatchObject({
      username: "zed",
      email: "zed@users.keel.invalid",
      emailVerified: false,
    });
    const userId: string = session.json.user.id;
    expect(userId).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await admins()).toEqual([{ id: userId }]);

    // Org keel, read back through Better Auth as any org is.
    const [keel, ...others] = await instanceOrgs();
    expect(others).toEqual([]);
    expect(keel?.id).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
    const full = await held("/organization/get-full-organization?organizationSlug=keel", {
      jar: begun.jar,
    });
    answered(full, 200);
    expect(full.json).toMatchObject({ id: keel?.id, name: "keel", slug: "keel" });
    expect(await membersOf(keel?.id ?? "")).toEqual([{ userId, role: "owner" }]);

    const orgs = await held("/organization/list", { jar: begun.jar });
    answered(orgs, 200);
    expect(orgs.json.map((o: { slug: string }) => o.slug).toSorted()).toEqual(["keel", "zed"]);
    const personal = orgs.json.find((o: { slug: string }) => o.slug === "zed");
    expect(await membersOf(personal.id)).toEqual([{ userId, role: "owner" }]);
    // Dates as Better Auth stores them, in org keel as in the org Better Auth made.
    const [personalRow] = await rows<{ createdAt: unknown }>(
      `SELECT createdAt FROM organization WHERE id = ?1`,
      personal.id,
    );
    expect(typeof keel?.createdAt).toBe(typeof personalRow?.createdAt);
    expect(new Date(String(keel?.createdAt)).getTime()).not.toBeNaN();
  });

  it("[claim.once] the code works once: after a claim, another held name is CLAIM_INVALID at either call, and the instance keeps one admin and one org keel", async () => {
    // Begun before the claim, finished after it: the second call finds the code spent.
    const early = await begin("zia", CODE);
    answered(early.options, 200);

    const claim = await begin("zoe", CODE);
    answered(claim.options, 200);
    answered(await finish(claim, CODE), 200);
    const [claimant] = await rows<{ id: string }>(`SELECT id FROM user WHERE username = 'zoe'`);

    refused(await finish(early, CODE), 403, "CLAIM_INVALID");
    refused((await begin("zia", CODE)).options, 403, "CLAIM_INVALID");

    expect(await admins()).toEqual([{ id: claimant?.id }]);
    const keel = await instanceOrgs();
    expect(keel).toHaveLength(1);
    expect(await membersOf(keel[0]?.id ?? "")).toEqual([{ userId: claimant?.id, role: "owner" }]);
    expect(await rows(`SELECT id FROM user WHERE username = 'zia' OR email LIKE 'zia@%'`)).toEqual(
      [],
    );
    toldNothing();
  });
});

describe("automation users (Admin_createUser's backend)", () => {
  const config = {
    db: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    host: env.KEEL_HOST,
    heldNames: new Set(["hal"]),
  };

  it("[admin.create-user-backend] makes a user with its personal org and a session whose token reads it as a bearer; a taken handle is NAME_TAKEN and a held one NAME_REFUSED", async () => {
    const made = await createUser(config, "Robo");
    if ("refused" in made) throw new Error(`refused: ${made.message}`);
    expect(made.userId).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(made.org).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(made.handle).toBe("robo");
    expect(made.session.token.length).toBeGreaterThan(16);
    const days = (made.session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    // keel.town's own entry reads the token as a bearer, with no cookie and no Origin.
    const bearer = { authorization: `Bearer ${made.session.token}` };
    const session = await site("/get-session", { headers: bearer, origin: null });
    answered(session, 200);
    expect(session.json.user).toMatchObject({
      id: made.userId,
      username: "robo",
      email: "robo@users.keel.invalid",
      emailVerified: false,
    });
    const orgs = await site("/organization/list", { headers: bearer, origin: null });
    answered(orgs, 200);
    expect(orgs.json).toEqual([expect.objectContaining({ id: made.org, slug: "robo" })]);
    expect(await membersOf(made.org)).toEqual([{ userId: made.userId, role: "owner" }]);

    expect(await createUser(config, "robo")).toEqual({
      refused: "NAME_TAKEN",
      message: expect.any(String),
    });
    expect(await createUser(config, "Hal")).toEqual({
      refused: "NAME_REFUSED",
      message: expect.any(String),
    });
    expect(await rows(`SELECT id FROM user WHERE username = 'hal' OR email LIKE 'hal@%'`)).toEqual(
      [],
    );
  });
});
