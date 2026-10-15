import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { UserId } from "@keeltown/core/kernel";
import { Enrolments } from "@keeltown/core/ports";
import { sampleProjectId } from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { ulid } from "ulid";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { EnrolmentsRpc } from "../../src/adapters/driven/do-rpc/enrolments.ts";
import { AgentSessionCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type Answer, Jar } from "./auth-harness.ts";
import { answered, handled, signUpByPasskey, site } from "./auth-users.ts";
import {
  aged,
  byBearer,
  byCookie,
  type Carried,
  PASSKEY_FIRST,
  signInByPasskey,
  stale,
} from "./auth-ways.ts";
import { BASE, drainAfter, POOL_ORG, POOL_SPONSOR, seedOrg, uniqueHandle } from "./helpers.ts";

/** Asks keel.town to delete the account a session is for. */
const close = (by: Carried, body: unknown = {}) => site("/delete-user", { body, ...by });

/** The id of the account a jar's session is for. */
async function idOf(jar: Jar): Promise<string> {
  const session = await site("/get-session", { jar });
  const id: unknown = session.json?.user?.id;
  if (typeof id !== "string") throw new Error(`no user in ${session.text}`);
  return id;
}

function refused(answer: Answer, status: number, code: string) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    status,
    code,
    expect.anything(),
  ]);
}

const count = async (sql: string, ...values: string[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

/** How many rows of each of Better Auth's tables name an account. */
const rowsOf = (userId: string) =>
  env.DB.prepare(
    `SELECT (SELECT count(*) FROM "user" WHERE id = ?1) AS user,
            (SELECT count(*) FROM session WHERE userId = ?1) AS session,
            (SELECT count(*) FROM account WHERE userId = ?1) AS account,
            (SELECT count(*) FROM passkey WHERE userId = ?1) AS passkey,
            (SELECT count(*) FROM member WHERE userId = ?1) AS member`,
  )
    .bind(userId)
    .first();

/** Whether the account's row is still there. */
const whole = async (userId: string) =>
  (await count(`SELECT count(*) AS n FROM "user" WHERE id = ?1`, userId)) === 1;

/** A project's place in a namespace, as project creation writes it. */
const place = (projectId: string, namespace: string, name: string) =>
  env.DB.prepare(`INSERT INTO projects (id, namespace_id, name, created_at) VALUES (?, ?, ?, 0)`)
    .bind(projectId, namespace, name)
    .run();

const unplace = (projectId: string) =>
  env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(projectId).run();

/** An org made by `owner`, answering its id. */
async function orgOf(owner: Jar, slug: string): Promise<string> {
  const made = await site("/organization/create", { body: { name: slug, slug }, jar: owner });
  answered(made, 200);
  return made.json.id;
}

/** `handle` joins an org as a member: invited by its owner, then accepting. */
async function joins(owner: Jar, organizationId: string, handle: string, invited: Jar) {
  const invitation = await site("/organization/invite-member", {
    body: { organizationId, role: "member", handle },
    jar: owner,
  });
  answered(invitation, 200);
  answered(
    await site("/organization/accept-invitation", {
      body: { invitationId: invitation.json.id },
      jar: invited,
    }),
    200,
  );
}

/** The handles of an org's members, as one of them reads the list. */
async function membersOf(reader: Jar, organizationId: string): Promise<string[]> {
  const listed = await site(`/organization/list-members?organizationId=${organizationId}`, {
    jar: reader,
  });
  answered(listed, 200);
  return listed.json.members.map((m: { user: { username: string } }) => m.user.username).toSorted();
}

const namespaceOf = async (handle: string) =>
  (await exports.default.fetch(`${BASE}/v1/namespaces/${handle}`)).status;

const agentSession = (agentId: string) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

const enrolling = EnrolmentsRpc(agentSession).pipe(Layer.provide(AgentDirectoryD1(env.DB)));

/** Who the directory says sponsors an agent, and how the agent stands. */
const linkOf = (agentId: string) =>
  env.DB.prepare(`SELECT sponsor_user, state FROM agents WHERE id = ?`).bind(agentId).first();

describe("deleting an account at /v1/auth", () => {
  it("[ba.delete] a person on a fresh passkey sign-in deletes their account: the session reads nobody, the passkey signs in no more, and no row of Better Auth's names them", async () => {
    const ada = await signUpByPasskey(uniqueHandle("closing"));
    const userId = await idOf(ada.jar);
    // A membership, and an account row as a provider's sign-in leaves one.
    await seedOrg(POOL_ORG, "pool", POOL_SPONSOR, "pool-sponsor");
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)`,
      ).bind(ulid(), POOL_ORG, userId, at),
      env.DB.prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, '1', 'github', ?, ?, ?)`,
      ).bind(ulid(), userId, at, at),
    ]);
    expect(await rowsOf(userId)).toEqual({
      user: 1,
      session: 1,
      account: 1,
      passkey: 1,
      member: 1,
    });

    const closed = await close(byCookie(ada.jar));
    answered(closed, 200);
    expect(closed.json).toEqual({ success: true, message: "User deleted" });

    expect((await site("/get-session", { jar: ada.jar })).json).toBeNull();
    expect(await rowsOf(userId)).toEqual({
      user: 0,
      session: 0,
      account: 0,
      passkey: 0,
      member: 0,
    });
    const jar = new Jar();
    const challenge = await site("/passkey/generate-authenticate-options", { jar });
    answered(challenge, 200);
    const asserted = await site("/passkey/verify-authentication", {
      body: { response: await ada.device.get(challenge.json.challenge) },
      jar,
    });
    expect([asserted.status, (await site("/get-session", { jar })).json]).toEqual([401, null]);
  });

  it("[ba.delete-forgets] a deleted account's device grants and the invitations addressed to it go with it, and nobody else's do", async () => {
    const handle = uniqueHandle("forgot");
    const bea = await signUpByPasskey(handle);
    const userId = await idOf(bea.jar);
    const other = uniqueHandle("stays");
    const cal = await signUpByPasskey(other);
    const owner = await signUpByPasskey(uniqueHandle("inviter"));
    const org = await orgOf(owner.jar, uniqueHandle("acct-org"));
    for (const invited of [handle, other])
      answered(
        await site("/organization/invite-member", {
          body: { organizationId: org, role: "member", handle: invited },
          jar: owner.jar,
        }),
        200,
      );
    for (const approver of [bea.jar, cal.jar]) {
      const code = await site("/device/code", { body: { client_id: "keeltown" } });
      answered(code, 200);
      const userCode: string = code.json.user_code;
      answered(
        await site(`/device?user_code=${encodeURIComponent(userCode)}`, { jar: approver }),
        200,
      );
      answered(await site("/device/approve", { body: { userCode }, jar: approver }), 200);
    }
    const held = async () => [
      await count(`SELECT count(*) AS n FROM deviceCode WHERE userId = ?1`, userId),
      await count(`SELECT count(*) AS n FROM invitation WHERE handle = ?1`, handle),
      await count(`SELECT count(*) AS n FROM deviceCode WHERE userId IS NOT NULL`),
      await count(`SELECT count(*) AS n FROM invitation WHERE organizationId = ?1`, org),
    ];
    expect(await held()).toEqual([1, 1, 2, 2]);

    answered(await close(byCookie(bea.jar)), 200);
    expect(await held()).toEqual([0, 0, 1, 1]);
  });

  it("[ba.delete-fresh] a session older than ten minutes, or one no passkey signed in, deletes nothing and is told the way forward; the passkey signing in again does", async () => {
    const cy = await signUpByPasskey(uniqueHandle("stale"));
    const userId = await idOf(cy.jar);
    await aged(cy.jar, 11);
    stale(await close(byCookie(cy.jar)));
    stale(await close(byBearer(cy.jar)));

    const handle = uniqueHandle("coded");
    const dee = await handled(`${handle}@example.com`, handle);
    stale(await close(byCookie(dee.jar)), PASSKEY_FIRST);
    expect([await whole(userId), await whole(dee.userId)]).toEqual([true, true]);

    answered(await close(byCookie(await signInByPasskey(cy.device))), 200);
    expect([await whole(userId), await whole(dee.userId)]).toEqual([false, true]);
  });

  it("[ba.delete-owns-projects] an account that owns a project is refused and told which, and is deleted once it owns none", async () => {
    const eve = await signUpByPasskey(uniqueHandle("owning"));
    const userId = await idOf(eve.jar);
    const projects = [`prj_${ulid()}`, `prj_${ulid()}`];
    await place(projects[0] ?? "", userId, "zephyr");
    await place(projects[1] ?? "", userId, "anvil");
    // Somebody else's project, in the org they are a member of, is no reason.
    await seedOrg(POOL_ORG, "pool", POOL_SPONSOR, "pool-sponsor");
    await place(`prj_${ulid()}`, POOL_ORG, uniqueHandle("theirs"));

    const kept = await close(byCookie(eve.jar));
    refused(kept, 400, "OWNS_PROJECTS");
    expect(kept.json.projects).toEqual(["anvil", "zephyr"]);
    expect(kept.json.message).toMatch(/anvil, zephyr/);
    expect(await whole(userId)).toBe(true);
    expect((await site("/get-session", { jar: eve.jar })).json?.user?.id).toBe(userId);

    for (const projectId of projects) await unplace(projectId);
    answered(await close(byCookie(eve.jar)), 200);
    expect(await whole(userId)).toBe(false);
  });

  it("[ba.delete-only-owner] the one owner of an org is refused and told which org, staying in every org they were in; with another owner there, they are deleted and the org's list names them no more", async () => {
    const [tam, tod] = [uniqueHandle("tam"), uniqueHandle("tod")];
    const owner = await signUpByPasskey(tam);
    const second = await signUpByPasskey(tod);
    const userId = await idOf(owner.jar);
    const [tealSlug, umberSlug] = [uniqueHandle("teal"), uniqueHandle("umber")];
    // Teal is theirs alone, though it has another member; in umber they are a member only.
    const teal = await orgOf(owner.jar, tealSlug);
    const umber = await orgOf(second.jar, umberSlug);
    await joins(owner.jar, teal, tod, second.jar);
    await joins(second.jar, umber, tam, owner.jar);

    const kept = await close(byCookie(owner.jar));
    refused(kept, 400, "ONLY_OWNER");
    expect(kept.json.orgs).toEqual([{ id: teal, slug: tealSlug }]);
    expect(kept.json.nextActions).toEqual([
      {
        kind: "call",
        title: "Make another member an owner first",
        operationId: "ManageOwners",
        args: { organizationId: teal },
      },
    ]);
    expect(await whole(userId)).toBe(true);
    expect([await membersOf(second.jar, teal), await membersOf(second.jar, umber)]).toEqual([
      [tam, tod].toSorted(),
      [tam, tod].toSorted(),
    ]);

    const members = await site(`/organization/list-members?organizationId=${teal}`, {
      jar: owner.jar,
    });
    const memberId: string = members.json.members.find(
      (m: { user: { username: string } }) => m.user.username === tod,
    ).id;
    answered(
      await site("/organization/update-member-role", {
        body: { organizationId: teal, memberId, role: "owner" },
        jar: owner.jar,
      }),
      200,
    );
    answered(await close(byCookie(owner.jar)), 200);
    expect(await whole(userId)).toBe(false);
    expect([await membersOf(second.jar, teal), await membersOf(second.jar, umber)]).toEqual([
      [tod],
      [tod],
    ]);
  });

  it("[ba.delete-handle-kept] a deleted person's handle reads as nobody's and is never issued again, to a person or to an org", async () => {
    const handle = uniqueHandle("gone");
    const gil = await signUpByPasskey(handle);
    const userId = await idOf(gil.jar);
    expect(await namespaceOf(handle)).toBe(200);

    answered(await close(byCookie(gil.jar)), 200);
    expect(await whole(userId)).toBe(false);
    expect(
      await env.DB.prepare(`SELECT id, kind FROM namespaces WHERE handle = ?`).bind(handle).first(),
    ).toEqual({ id: userId, kind: "user" });
    expect(await namespaceOf(handle)).toBe(404);

    const next = await signUpByPasskey(uniqueHandle("next"));
    const signUp = await site(
      `/passkey/generate-register-options?context=${encodeURIComponent(handle)}`,
      { jar: new Jar() },
    );
    const org = await site("/organization/create", {
      body: { name: handle, slug: handle },
      jar: next.jar,
    });
    expect([signUp, org].map((answer) => [answer.status, answer.json.code])).toEqual([
      [400, "NAME_TAKEN"],
      [400, "NAME_TAKEN"],
    ]);
  });

  it("[ba.delete-unsponsors] deleting an account ends its sponsor links as the person, after every refusal: the agent is told, names no sponsor, and still stands", async () => {
    const hal = await signUpByPasskey(uniqueHandle("backer"));
    const userId = Schema.decodeSync(UserId)(await idOf(hal.jar));
    // Enrolled into the person's own namespace, as the older credential path does.
    const { agent } = await Effect.runPromise(
      Enrolments.use((enrol) =>
        enrol.enrol(
          { _tag: "User", userId },
          {
            name: "kept-agent",
            kind: "interactive",
            scopes: ["agent:read", "agent:work"],
            projectId: sampleProjectId,
            namespace: userId,
            sponsor: userId,
            idempotencyKey: `enrol-${ulid()}`,
          },
        ),
      ).pipe(Effect.provide(enrolling)),
    );
    expect(await linkOf(agent.id)).toEqual({ sponsor_user: userId, state: "active" });

    // A refusal leaves the link standing: nothing changes before every check has passed.
    const projectId = `prj_${ulid()}`;
    await place(projectId, userId, "held");
    refused(await close(byCookie(hal.jar)), 400, "OWNS_PROJECTS");
    expect(await linkOf(agent.id)).toEqual({ sponsor_user: userId, state: "active" });
    await unplace(projectId);

    answered(await close(byCookie(hal.jar)), 200);
    expect(await whole(userId)).toBe(false);
    expect(await linkOf(agent.id)).toEqual({ sponsor_user: null, state: "active" });
    const inbox = decodeExit(
      AgentSessionCodecs.inbox,
      await agentSession(agent.id).inbox({ waitMs: 0 }),
    );
    if (!Exit.isSuccess(inbox)) throw new Error("the inbox read failed");
    expect(inbox.value.notices.map((notice) => [notice.kind, notice.detail])).toEqual([
      ["AgentUnsponsored", "nobody sponsors you now"],
    ]);
  });

  it("[ba.delete-own-way] no link deletes an account and no body's token or password does: Better Auth's other ways in are closed, whatever it holds for them", async () => {
    const ivy = await signUpByPasskey(uniqueHandle("own-way"));
    const userId = await idOf(ivy.jar);
    // The row Better Auth's mailed link would be checked against, for each way it reads one.
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    for (const token of ["by-link", "by-body"])
      await env.DB.prepare(
        `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(ulid(), `delete-account-${token}`, userId, until, at, at)
        .run();
    const unspent = () => count(`SELECT count(*) AS n FROM verification WHERE value = ?1`, userId);

    const byLink = await site("/delete-user/callback?token=by-link", { jar: ivy.jar });
    expect([byLink.status, await whole(userId), await unspent()]).toEqual([404, true, 2]);
    refused(await close(byCookie(ivy.jar), { token: "by-body" }), 400, "PASSKEY_ONLY");
    refused(await close(byCookie(ivy.jar), { password: "correct horse" }), 400, "PASSKEY_ONLY");
    expect([await whole(userId), await unspent()]).toEqual([true, 2]);
    expect((await site("/get-session", { jar: ivy.jar })).json?.user?.id).toBe(userId);
  });
});
