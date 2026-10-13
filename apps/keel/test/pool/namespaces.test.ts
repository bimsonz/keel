// Namespaces through the real path: the database writes a handle's row with
// its account, a person's own namespace has no members, a handle has one
// holder for good, and 0010 re-homes what the personal orgs held.
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { RESERVED_SEGMENTS } from "@keeltown/contracts";
import { describe, expect, it } from "vitest";
import { HANDLE_HOLDER } from "../../src/adapters/driven/better-auth/auth.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { Authenticator, caller, Jar } from "./auth-harness.ts";
import {
  answered,
  call,
  handled,
  outbox,
  signUpByCode,
  signUpByPasskey,
  site,
} from "./auth-users.ts";
import { BASE } from "./helpers.ts";

/** A handle's row in `namespaces`: whose it is and of which kind, or null while nobody holds it. */
const namespaceRow = (handle: string, db = env.DB) =>
  db
    .prepare(`SELECT id, kind FROM namespaces WHERE handle = ?`)
    .bind(handle)
    .first<{ id: string; kind: string }>();

const count = async (sql: string, ...values: string[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;
const usersNamed = (handle: string) =>
  count(`SELECT COUNT(*) AS n FROM "user" WHERE username = ?`, handle);
const orgsNamed = (slug: string) =>
  count(`SELECT COUNT(*) AS n FROM organization WHERE slug = ?`, slug);
const memberRowsOf = (userId: string) =>
  count(`SELECT COUNT(*) AS n FROM member WHERE userId = ?`, userId);

const userIdOf = async (jar: Jar, via = site) => {
  const userId: unknown = (await via("/get-session", { jar })).json.user.id;
  if (typeof userId !== "string") throw new Error("the jar holds no session");
  return userId;
};

/** `GET /v1/namespaces/{handle}`, as anyone. */
const namespaceOf = async (handle: string) => {
  const answer = await exports.default.fetch(`${BASE}/v1/namespaces/${handle}`);
  return { status: answer.status, body: await answer.json<Record<string, unknown>>() };
};

describe("a person's namespace", () => {
  it("[ns.sign-up] a sign-up writes the person's namespace under their own id and makes no org: by passkey with the account, by code when the handle is chosen", async () => {
    const { jar } = await signUpByPasskey("Nia");
    const nia = await userIdOf(jar);
    expect(await namespaceRow("nia")).toEqual({ id: nia, kind: "user" });

    const omar = await signUpByCode("ns-omar@example.com");
    expect(
      await count(`SELECT COUNT(*) AS n FROM namespaces WHERE id = ?`, omar.userId),
      "no namespace before a handle",
    ).toBe(0);
    answered(await call("/update-user", { body: { username: "Omar" }, jar: omar.jar }), 200);
    expect(await namespaceRow("omar")).toEqual({ id: omar.userId, kind: "user" });

    expect([await orgsNamed("nia"), await orgsNamed("omar")]).toEqual([0, 0]);
    expect([await memberRowsOf(nia), await memberRowsOf(omar.userId)]).toEqual([0, 0]);
    expect((await site("/organization/list", { jar })).json).toEqual([]);
  });

  it("[ns.no-members] Better Auth's org routes answer a person's namespace as no org: missing by handle and by id, and its own person no member of it to invite, list or make it active", async () => {
    const pia = await handled("ns-pia@example.com", "pia");
    const byHandle = await call("/organization/get-full-organization?organizationSlug=pia", {
      jar: pia.jar,
    });
    const byId = await call(`/organization/get-full-organization?organizationId=${pia.userId}`, {
      jar: pia.jar,
    });
    const invite = await call("/organization/invite-member", {
      body: { email: "guest@example.com", role: "member", organizationId: pia.userId },
      jar: pia.jar,
    });
    const members = await call(`/organization/list-members?organizationId=${pia.userId}`, {
      jar: pia.jar,
    });
    const active = await call("/organization/set-active", {
      body: { organizationId: pia.userId },
      jar: pia.jar,
    });
    expect(
      [byHandle, byId, invite, members, active].map((answer) => [answer.status, answer.json?.code]),
    ).toEqual([
      [400, "ORGANIZATION_NOT_FOUND"],
      [400, "ORGANIZATION_NOT_FOUND"],
      // Better Auth asks who the caller is in the org before it asks whether the org exists.
      [400, "MEMBER_NOT_FOUND"],
      [403, "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION"],
      [403, "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"],
    ]);
    expect(await memberRowsOf(pia.userId)).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM invitation WHERE organizationId = ?`, pia.userId),
    ).toBe(0);
    const session = await call("/get-session", { jar: pia.jar });
    expect(session.json.session.activeOrganizationId ?? null).toBeNull();
  });
});

describe("a handle has one holder", () => {
  /** Better Auth's own reads of who holds a username or an org's slug, as its adapter writes them. */
  const BETTER_AUTH_HOLDER =
    /^select\b.*\bfrom "(user|organization)" where (?:"\w+"\.)?"(username|slug)" = \?/i;

  /**
   * keel.town with `nameUnavailable`'s read answering that nobody holds the
   * handle, as it does for the loser of two requests in the same moment. With
   * `late` Better Auth's own read still sees the holder; without it that read
   * is as blind, and the database is all that stands between the request and
   * a second holder.
   */
  const racing = (late: boolean) => {
    const none = { success: true, results: [], meta: { changes: 0, last_row_id: 0, duration: 0 } };
    const unheld = { bind: () => ({ first: async () => null, all: async () => none }) };
    const blind: D1Database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql === HANDLE_HOLDER || (!late && BETTER_AUTH_HOLDER.test(sql))
              ? unheld
              : target.prepare(sql);
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const isolate = makeIsolate({ ...env, DB: blind }, isolateLayer(env), {
      sendOtp: async (message) => {
        outbox.push(message);
      },
    });
    return caller(async (request) => isolate.app.fetch(request, env, createExecutionContext()));
  };

  it("[ns.unique] a sign-up and an org creation that take a held handle past the read are refused NAME_TAKEN by the database, and leave no user and no org behind", async () => {
    const quin = await handled("ns-quin@example.com", "quin");
    answered(
      await call("/organization/create", { body: { name: "Rook", slug: "rook" }, jar: quin.jar }),
      200,
    );
    // Each way a handle is taken, against a person's handle and against an org's: once with Better
    // Auth's own read seeing the holder, once with the database alone.
    const answers: Record<string, [number, unknown]> = {};
    for (const late of [true, false]) {
      const lost = racing(late);
      for (const held of ["quin", "rook"]) {
        const at = `${held}, ${late ? "read late" : "unread"}`;
        // A passkey sign-up: the account and its handle are one insert.
        const jar = new Jar();
        const options = await lost(`/passkey/generate-register-options?context=${held}`, { jar });
        answered(options, 200);
        const signUp = await lost("/passkey/verify-registration", {
          body: {
            response: await new Authenticator().create(options.json.challenge),
            createSession: true,
          },
          jar,
        });
        answers[`sign-up as ${at}`] = [signUp.status, signUp.json.code];
        expect((await call("/get-session", { jar })).json).toBeNull();

        // A handle chosen after a sign-up by code: the user stays, without it.
        const coded = await signUpByCode(`ns-${held}-${late}@example.com`);
        const chosen = await lost("/update-user", { body: { username: held }, jar: coded.jar });
        answers[`handle ${at}`] = [chosen.status, chosen.json.code];
        expect((await call("/get-session", { jar: coded.jar })).json.user.username).toBeNull();

        const made = await lost("/organization/create", {
          body: { name: "Second", slug: held },
          jar: quin.jar,
        });
        answers[`org ${at}`] = [made.status, made.json.code];
      }
    }
    // An org taking an org's handle, when Better Auth's read of slugs sees the holder, is refused by
    // that read inside its endpoint, with its own code, where no hook of Keel's sees the refusal.
    expect(
      Object.entries(answers).filter(([, answer]) => answer.join() !== "400,NAME_TAKEN"),
    ).toEqual([["org rook, read late", [400, "ORGANIZATION_ALREADY_EXISTS"]]]);
    expect(Object.keys(answers)).toHaveLength(12);
    expect([await usersNamed("quin"), await usersNamed("rook")]).toEqual([1, 0]);
    expect([await orgsNamed("quin"), await orgsNamed("rook")]).toEqual([0, 1]);
    expect(await namespaceRow("quin")).toEqual({ id: quin.userId, kind: "user" });
    expect(await namespaceRow("rook")).toMatchObject({ kind: "org" });
  });

  it("[ns.kind] a handle answers whose it is and of which kind, in any case: a person's own or an org", async () => {
    const tess = await handled("ns-tess@example.com", "tess");
    const org = await call("/organization/create", {
      body: { name: "Umbra", slug: "umbra" },
      jar: tess.jar,
    });
    answered(org, 200);

    expect(await namespaceOf("TESS")).toEqual({
      status: 200,
      body: { id: tess.userId, handle: "tess", kind: "user" },
    });
    expect(await namespaceOf("Umbra")).toEqual({
      status: 200,
      body: { id: org.json.id, handle: "umbra", kind: "org" },
    });
    const nobody = await namespaceOf("nobody-here");
    expect([nobody.status, nobody.body["code"]]).toEqual([404, "resource.not_found"]);
  });

  it("[ns.own-handle] a person's own handle is taken like any other: no org of theirs takes it, and it is not chosen a second time", async () => {
    const uma = await handled("ns-uma@example.com", "uma");
    const org = await call("/organization/create", {
      body: { name: "Uma", slug: "uma" },
      jar: uma.jar,
    });
    const again = await call("/update-user", { body: { username: "uma" }, jar: uma.jar });
    expect([org, again].map((answer) => [answer.status, answer.json.code])).toEqual([
      [400, "NAME_TAKEN"],
      [400, "NAME_TAKEN"],
    ]);
    expect(await orgsNamed("uma")).toBe(0);
    expect(await namespaceRow("uma")).toEqual({ id: uma.userId, kind: "user" });
  });

  it("[ns.reserved] every first segment keel.town serves itself is refused as a handle, in any case: at a passkey sign-up, when a handle is chosen and at org creation", async () => {
    const vera = await handled("ns-vera@example.com", "vera");
    const wren = await signUpByCode("ns-wren@example.com");
    const refused: [string, string, number, unknown][] = [];
    for (const segment of RESERVED_SEGMENTS) {
      const name = segment.toUpperCase();
      const answers = {
        "sign-up": await site(`/passkey/generate-register-options?context=${name}`, {
          jar: new Jar(),
        }),
        handle: await call("/update-user", { body: { username: name }, jar: wren.jar }),
        org: await call("/organization/create", { body: { name, slug: name }, jar: vera.jar }),
      };
      for (const [at, answer] of Object.entries(answers))
        if (answer.status !== 400 || answer.json?.code !== "NAME_REFUSED")
          refused.push([segment, at, answer.status, answer.json?.code]);
      // The refusal names the segment and no host: a Keel served anywhere says the same.
      expect(answers.org.json.message).toBe(`"${name}" is reserved`);
      expect(await namespaceRow(segment)).toBeNull();
    }
    expect(refused).toEqual([]);
    expect(RESERVED_SEGMENTS).toContain("sponsor");
  });

  it("[ns.handle-once] a deleted org's handle reads as nobody's and is never issued again, to a person or to an org", async () => {
    const xan = await handled("ns-xan@example.com", "xan");
    const org = await call("/organization/create", {
      body: { name: "Yonder", slug: "yonder" },
      jar: xan.jar,
    });
    answered(org, 200);
    expect((await namespaceOf("yonder")).status).toBe(200);
    answered(
      await call("/organization/delete", { body: { organizationId: org.json.id }, jar: xan.jar }),
      200,
    );
    expect(await orgsNamed("yonder")).toBe(0);

    expect((await namespaceOf("yonder")).status).toBe(404);
    expect(await namespaceRow("yonder")).toEqual({ id: org.json.id, kind: "org" });
    const again = await call("/organization/create", {
      body: { name: "Yonder", slug: "yonder" },
      jar: xan.jar,
    });
    const zed = await signUpByCode("ns-zed@example.com");
    const chosen = await call("/update-user", { body: { username: "yonder" }, jar: zed.jar });
    const signUp = await site("/passkey/generate-register-options?context=yonder", {
      jar: new Jar(),
    });
    expect([again, chosen, signUp].map((answer) => [answer.status, answer.json.code])).toEqual([
      [400, "NAME_TAKEN"],
      [400, "NAME_TAKEN"],
      [400, "NAME_TAKEN"],
    ]);
  });
});

/** The empty database beside `DB`, where 0010 runs over rows written before it. */
const run = (sql: string, ...values: (string | number | null)[]) =>
  env.TEST_BACKFILL_DB.prepare(sql)
    .bind(...values)
    .run();
const all = async <Row>(sql: string) =>
  (await env.TEST_BACKFILL_DB.prepare(sql).all<Row>()).results;

const AT = "2026-10-12T20:00:00.000Z";

const user = (id: string, handle: string | null) =>
  run(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES (?, ?, ?, 0, ?, ?, ?)`,
    id,
    handle ?? id,
    `${id}@users.keel.invalid`,
    AT,
    AT,
    handle,
  );
const org = (id: string, slug: string) =>
  run(
    `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`,
    id,
    slug,
    slug,
    AT,
  );
const member = (orgId: string, userId: string, role: string) =>
  run(
    `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`,
    `mem_${orgId}_${userId}`,
    orgId,
    userId,
    role,
    AT,
  );
const project = (id: string, orgId: string, name: string) =>
  run(`INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, 1)`, id, orgId, name);
const agent = (id: string, projectId: string, orgId: string | null, sponsor: string | null) =>
  run(
    `INSERT INTO agents (id, name, kind, scopes, state, created_at, project_id, org_id, sponsor_user) VALUES (?, ?, 'interactive', '[]', 'active', 1, ?, ?, ?)`,
    id,
    id,
    projectId,
    orgId,
    sponsor,
  );

describe("migration 0010 over what keel.town held", () => {
  it("[ns.backfill] re-homes each personal org's projects and agents to its person, keeps a real org with its members, and leaves no personal org, member row, invitation or active org behind", async () => {
    await applyD1Migrations(
      env.TEST_BACKFILL_DB,
      env.TEST_MIGRATIONS.filter((migration) => migration.name < "0010"),
    );
    // The live shape: people with a personal org each (one with a second member), one real org
    // whose owner is a person, projects and placed agents under personal orgs, an agent enrolled
    // before tenancy, a session whose active org is a personal one, and a person with no handle yet.
    await user("usr_ada", "ada");
    await user("usr_bob", "bob");
    await user("usr_cy", "cy");
    await user("usr_new", null);
    await org("org_ada", "ada");
    await org("org_bob", "bob");
    await org("org_cy", "cy");
    await org("org_keel", "keel");
    await member("org_ada", "usr_ada", "owner");
    await member("org_bob", "usr_bob", "owner");
    await member("org_bob", "usr_ada", "member");
    await member("org_cy", "usr_cy", "owner");
    await member("org_keel", "usr_ada", "owner");
    await member("org_keel", "usr_cy", "maintainer");
    await project("prj_one", "org_ada", "forge");
    await project("prj_two", "org_bob", "forge");
    await project("prj_three", "org_bob", "smoke");
    await project("prj_keel", "org_keel", "keel");
    await agent("agt_one", "prj_one", "org_ada", "usr_ada");
    await agent("agt_two", "prj_two", "org_bob", "usr_bob");
    await agent("agt_keel", "prj_keel", "org_keel", "usr_cy");
    await agent("agt_early", "prj_one", null, null);
    for (const [id, active] of [
      ["ses_bob", "org_bob"],
      ["ses_keel", "org_keel"],
    ] as const)
      await run(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, activeOrganizationId) VALUES (?, ?, ?, ?, ?, 'usr_bob', ?)`,
        id,
        AT,
        id,
        AT,
        AT,
        active,
      );
    for (const [id, orgId] of [
      ["inv_bob", "org_bob"],
      ["inv_keel", "org_keel"],
    ] as const)
      await run(
        `INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES (?, ?, 'guest@example.com', 'member', 'pending', ?, ?, 'usr_ada')`,
        id,
        orgId,
        AT,
        AT,
      );

    await applyD1Migrations(env.TEST_BACKFILL_DB, env.TEST_MIGRATIONS);

    expect(await all(`SELECT id, handle, kind FROM namespaces ORDER BY handle`)).toEqual([
      { id: "usr_ada", handle: "ada", kind: "user" },
      { id: "usr_bob", handle: "bob", kind: "user" },
      { id: "usr_cy", handle: "cy", kind: "user" },
      { id: "org_keel", handle: "keel", kind: "org" },
    ]);
    expect(await all(`SELECT id, namespace_id, name FROM projects ORDER BY id`)).toEqual([
      { id: "prj_keel", namespace_id: "org_keel", name: "keel" },
      { id: "prj_one", namespace_id: "usr_ada", name: "forge" },
      { id: "prj_three", namespace_id: "usr_bob", name: "smoke" },
      { id: "prj_two", namespace_id: "usr_bob", name: "forge" },
    ]);
    expect(await all(`SELECT id, namespace_id, sponsor_user FROM agents ORDER BY id`)).toEqual([
      { id: "agt_early", namespace_id: null, sponsor_user: null },
      { id: "agt_keel", namespace_id: "org_keel", sponsor_user: "usr_cy" },
      { id: "agt_one", namespace_id: "usr_ada", sponsor_user: "usr_ada" },
      { id: "agt_two", namespace_id: "usr_bob", sponsor_user: "usr_bob" },
    ]);
    expect(await all(`SELECT id FROM organization`)).toEqual([{ id: "org_keel" }]);
    expect(await all(`SELECT userId, role FROM member ORDER BY userId`)).toEqual([
      { userId: "usr_ada", role: "owner" },
      { userId: "usr_cy", role: "maintainer" },
    ]);
    expect(await all(`SELECT id FROM invitation`)).toEqual([{ id: "inv_keel" }]);
    expect(await all(`SELECT id, activeOrganizationId FROM session ORDER BY id`)).toEqual([
      { id: "ses_bob", activeOrganizationId: null },
      { id: "ses_keel", activeOrganizationId: "org_keel" },
    ]);
    expect(await all(`PRAGMA foreign_key_check`)).toEqual([]);

    // The same name under one namespace is still refused, and a person signing up after it is written as any other.
    await expect(
      run(
        `INSERT INTO projects (id, namespace_id, name, created_at) VALUES ('prj_four', 'usr_bob', 'forge', 1)`,
      ),
    ).rejects.toThrow(/UNIQUE/);
    await user("usr_dee", "dee");
    expect(await namespaceRow("dee", env.TEST_BACKFILL_DB)).toEqual({
      id: "usr_dee",
      kind: "user",
    });
  });
});
