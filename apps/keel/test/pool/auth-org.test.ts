import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Answer, Jar } from "./auth-harness.ts";
import { answered, call, handled, signUpByPasskey } from "./auth-users.ts";

/** An org made by `owner`, answering its id. */
async function orgOf(owner: Jar, slug: string): Promise<string> {
  const made = await call("/organization/create", { body: { name: slug, slug }, jar: owner });
  answered(made, 200);
  return made.json.id;
}

const invite = (
  jar: Jar,
  organizationId: string,
  target: { handle?: string; email?: string },
  role = "member",
) => call("/organization/invite-member", { body: { organizationId, role, ...target }, jar });

const getInvitation = (jar: Jar, id: string) =>
  call(`/organization/get-invitation?id=${encodeURIComponent(id)}`, { jar });

const accept = (jar: Jar, invitationId: string) =>
  call("/organization/accept-invitation", { body: { invitationId }, jar });

function refused(answer: Answer, status: number, code: string) {
  expect([answer.status, answer.json?.code, answer.text]).toEqual([
    status,
    code,
    expect.anything(),
  ]);
}

const setRole = (jar: Jar, organizationId: string, memberId: string, role: string) =>
  call("/organization/update-member-role", { body: { organizationId, memberId, role }, jar });

const remove = (jar: Jar, organizationId: string, memberIdOrEmail: string) =>
  call("/organization/remove-member", { body: { organizationId, memberIdOrEmail }, jar });

/** Each member's handle and role in an org, read from D1. */
async function rolesIn(organizationId: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT u.username, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?1`,
  )
    .bind(organizationId)
    .all<{ username: string; role: string }>();
  return Object.fromEntries(results.map((r) => [r.username, r.role]));
}

async function memberIdOf(organizationId: string, handle: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT m.id FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?1 AND u.username = ?2`,
  )
    .bind(organizationId, handle)
    .first<{ id: string }>();
  if (row === null) throw new Error(`${handle} is not a member`);
  return row.id;
}

/** The emails in an answer, wherever they sit. */
const emailsIn = (answer: Answer) =>
  [...answer.text.matchAll(/[\w.+-]+@[\w.-]+/g)].map((m) => m[0]);

describe("orgs at /v1/auth/organization", () => {
  it("[ba.invite-handle] invites by handle or by email, never both or neither, and a handle invitation carries no email", async () => {
    const olga = await handled("olga@example.com", "olga");
    const orchard = await orgOf(olga.jar, "orchard");
    await signUpByPasskey("otto");

    refused(await invite(olga.jar, orchard, {}), 400, "INVITE_TARGET");
    refused(
      await invite(olga.jar, orchard, { handle: "otto", email: "otto@example.com" }),
      400,
      "INVITE_TARGET",
    );
    refused(await invite(olga.jar, orchard, { handle: "nobody" }), 400, "NO_SUCH_HANDLE");
    refused(
      await invite(olga.jar, orchard, { email: "otto@users.keel.invalid" }),
      400,
      "EMAIL_UNDELIVERABLE",
    );

    const invited = await invite(olga.jar, orchard, { handle: "Otto" });
    answered(invited, 200);
    expect(invited.json).toMatchObject({
      handle: "otto",
      organizationId: orchard,
      status: "pending",
    });
    expect(invited.json).not.toHaveProperty("email");
    const typed = await invite(olga.jar, orchard, { email: "Quinn@Example.com" });
    answered(typed, 200);
    expect(typed.json.email).toBe("quinn@example.com");
    expect(typed.json.handle ?? null).toBeNull();

    const listed = await call(`/organization/list-invitations?organizationId=${orchard}`, {
      jar: olga.jar,
    });
    answered(listed, 200);
    const byId = new Map(listed.json.map((i: { id: string }) => [i.id, i]));
    expect(byId.get(invited.json.id)).not.toHaveProperty("email");
    expect(byId.get(typed.json.id)).toMatchObject({ email: "quinn@example.com" });
  });

  it("[ba.invite-accept] a passkey-only user lists, reads and accepts a handle invitation; a typed one waits on a verified address", async () => {
    const pam = await handled("pam@example.com", "pam");
    const plum = await orgOf(pam.jar, "plum");
    const piet = await signUpByPasskey("piet");
    const sent = await invite(pam.jar, plum, { handle: "piet" });
    answered(sent, 200);

    const mine = await call("/organization/list-user-invitations", { jar: piet.jar });
    answered(mine, 200);
    expect(mine.json).toEqual([
      expect.objectContaining({ id: sent.json.id, handle: "piet", organizationSlug: "plum" }),
    ]);
    expect(mine.json[0]).not.toHaveProperty("email");

    const read = await getInvitation(piet.jar, sent.json.id);
    answered(read, 200);
    expect(read.json).toMatchObject({
      handle: "piet",
      inviterHandle: "pam",
      organizationSlug: "plum",
    });
    expect(read.json).not.toHaveProperty("email");
    expect(read.json).not.toHaveProperty("inviterEmail");
    answered(await accept(piet.jar, sent.json.id), 200);
    const members = await call(`/organization/list-members?organizationId=${plum}`, {
      jar: piet.jar,
    });
    expect(
      members.json.members.map((m: { user: { username: string } }) => m.user.username),
    ).toEqual(expect.arrayContaining(["pam", "piet"]));

    // An address its holder hasn't verified (as GitHub can hand over) doesn't receive a typed invitation.
    const pru = await handled("pru@example.com", "pru");
    await env.DB.prepare(`UPDATE user SET emailVerified = 0 WHERE id = ?1`).bind(pru.userId).run();
    const typed = await invite(pam.jar, plum, { email: "pru@example.com" });
    answered(typed, 200);
    refused(await getInvitation(pru.jar, typed.json.id), 400, "INVITATION_NOT_FOUND");
    refused(await accept(pru.jar, typed.json.id), 400, "INVITATION_NOT_FOUND");
    expect((await call("/organization/list-user-invitations", { jar: pru.jar })).json).toEqual([]);
    await env.DB.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?1`).bind(pru.userId).run();
    answered(await accept(pru.jar, typed.json.id), 200);
  });

  it("[ba.member-privacy] members carry handles, and emails only their own; a typed invitation's email only for managers and its invitee", async () => {
    const rae = await handled("rae@example.com", "rae");
    const reef = await orgOf(rae.jar, "reef");
    const roy = await signUpByPasskey("roy");
    const rue = await handled("rue@example.com", "rue");
    const toRoy = await invite(rae.jar, reef, { handle: "roy" });
    const toRue = await invite(rae.jar, reef, { email: "rue@example.com" }, "maintainer");
    answered(await accept(roy.jar, toRoy.json.id), 200);
    answered(await accept(rue.jar, toRue.json.id), 200);
    const pending = await invite(rae.jar, reef, { email: "ray@example.com" });
    answered(pending, 200);

    const reads = (jar: Jar) =>
      Promise.all([
        call(`/organization/get-full-organization?organizationId=${reef}`, { jar }),
        call(`/organization/list-members?organizationId=${reef}`, { jar }),
        call(`/organization/list-invitations?organizationId=${reef}`, { jar }),
        call("/organization/set-active", { body: { organizationId: reef }, jar }),
      ]).then(async (answers) => [
        ...answers,
        await call("/organization/get-active-member", { jar }),
      ]);

    // Roy is a member: his own placeholder at most, no one else's address, not even the typed invitee's.
    const byRoy = await reads(roy.jar);
    for (const answer of byRoy) {
      answered(answer, 200);
      expect(emailsIn(answer).filter((e) => e !== "roy@users.keel.invalid")).toEqual([]);
    }
    const full = byRoy[0]?.json;
    expect(
      full.members.map((m: { user: { username: string; email?: string } }) => [
        m.user.username,
        m.user.email ?? null,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["rae", null],
        ["rue", null],
        ["roy", "roy@users.keel.invalid"],
      ]),
    );

    // Rue is a maintainer: the typed invitation's address, but still no other member's.
    const byRue = await reads(rue.jar);
    for (const answer of byRue) answered(answer, 200);
    const seen = new Set(byRue.flatMap(emailsIn));
    expect(seen.has("ray@example.com")).toBe(true);
    expect(seen.has("rae@example.com")).toBe(false);
    expect(seen.has("roy@users.keel.invalid")).toBe(false);

    // The owner sees the typed address too, and every answer to a member's write follows the same rule.
    const byRae = await call(`/organization/list-invitations?organizationId=${reef}`, {
      jar: rae.jar,
    });
    expect(emailsIn(byRae)).toContain("ray@example.com");
    const writes = [
      await call("/organization/cancel-invitation", {
        body: { invitationId: pending.json.id },
        jar: rae.jar,
      }),
      await call("/organization/update-member-role", {
        body: {
          organizationId: reef,
          memberId: full.members.find(
            (m: { user: { username: string } }) => m.user.username === "roy",
          ).id,
          role: "maintainer",
        },
        jar: rae.jar,
      }),
    ];
    for (const answer of writes) {
      answered(answer, 200);
      expect(emailsIn(answer).filter((e) => e !== "ray@example.com")).toEqual([]);
    }
  });

  it("[ba.invitation-answered] tells only the recipient, and in words, that an invitation was answered or has lapsed", async () => {
    const sal = await handled("sal@example.com", "sal");
    const sage = await orgOf(sal.jar, "sage");
    const sid = await signUpByPasskey("sid");
    const sol = await signUpByPasskey("sol");
    const toSid = await invite(sal.jar, sage, { handle: "sid" });
    const toSol = await invite(sal.jar, sage, { handle: "sol" });

    // Someone else's invitation reads exactly as an unknown one, whatever its state.
    const unknown = await getInvitation(sol.jar, "01M4ZZZZZZZZZZZZZZZZZZZZZZ");
    refused(unknown, 400, "INVITATION_NOT_FOUND");
    expect((await getInvitation(sol.jar, toSid.json.id)).json).toEqual(unknown.json);
    refused(await accept(sol.jar, toSid.json.id), 400, "INVITATION_NOT_FOUND");

    answered(await accept(sid.jar, toSid.json.id), 200);
    refused(await getInvitation(sid.jar, toSid.json.id), 400, "INVITATION_ANSWERED");
    expect((await getInvitation(sol.jar, toSid.json.id)).json).toEqual(unknown.json);

    answered(
      await call("/organization/reject-invitation", {
        body: { invitationId: toSol.json.id },
        jar: sol.jar,
      }),
      200,
    );
    const rejected = await getInvitation(sol.jar, toSol.json.id);
    refused(rejected, 400, "INVITATION_ANSWERED");
    expect(rejected.json.message).toContain("rejected");

    const syd = await signUpByPasskey("syd");
    const toSyd = await invite(sal.jar, sage, { handle: "syd" });
    const row = await env.DB.prepare(`SELECT expiresAt FROM invitation WHERE id = ?1`)
      .bind(toSyd.json.id)
      .first<{ expiresAt: string | number }>();
    const past = typeof row?.expiresAt === "number" ? 0 : "2000-01-01T00:00:00.000Z";
    await env.DB.prepare(`UPDATE invitation SET expiresAt = ?2 WHERE id = ?1`)
      .bind(toSyd.json.id, past)
      .run();
    refused(await getInvitation(syd.jar, toSyd.json.id), 400, "INVITATION_LAPSED");
    refused(await accept(syd.jar, toSyd.json.id), 400, "INVITATION_LAPSED");
  });

  it("[ba.only-owner] an org's only owner can't leave or step down, and is told to name another owner first", async () => {
    const tam = await handled("tam@example.com", "tam");
    const teal = await orgOf(tam.jar, "teal");
    const tod = await signUpByPasskey("tod");
    answered(await accept(tod.jar, (await invite(tam.jar, teal, { handle: "tod" })).json.id), 200);
    const members = await call(`/organization/list-members?organizationId=${teal}`, {
      jar: tam.jar,
    });
    const idOf = (handle: string) =>
      members.json.members.find((m: { user: { username: string } }) => m.user.username === handle)
        .id;

    const left = await call("/organization/leave", {
      body: { organizationId: teal },
      jar: tam.jar,
    });
    refused(left, 400, "ONLY_OWNER");
    expect(left.json.nextActions).toEqual([
      {
        kind: "call",
        title: "Make another member an owner first",
        operationId: "ManageOwners",
        args: { organizationId: teal },
      },
    ]);
    refused(
      await call("/organization/update-member-role", {
        body: { organizationId: teal, memberId: idOf("tam"), role: "member" },
        jar: tam.jar,
      }),
      400,
      "ONLY_OWNER",
    );

    answered(
      await call("/organization/update-member-role", {
        body: { organizationId: teal, memberId: idOf("tod"), role: "owner" },
        jar: tam.jar,
      }),
      200,
    );
    answered(
      await call("/organization/leave", { body: { organizationId: teal }, jar: tam.jar }),
      200,
    );
  });

  it("[ba.org-roles] a maintainer invites, removes, and moves members between member and maintainer; making or unmaking an owner, and deleting the org, stay with owners; a member can't invite", async () => {
    const uma = await handled("uma@example.com", "uma");
    const urn = await orgOf(uma.jar, "urn");
    const ula = await signUpByPasskey("ula");
    const uli = await signUpByPasskey("uli");
    answered(
      await accept(ula.jar, (await invite(uma.jar, urn, { handle: "ula" }, "maintainer")).json.id),
      200,
    );
    answered(await accept(uli.jar, (await invite(uma.jar, urn, { handle: "uli" })).json.id), 200);

    // Ula, a maintainer, invites a member, moves members between member and maintainer, and removes one.
    const uno = await signUpByPasskey("uno");
    const toUno = await invite(ula.jar, urn, { handle: "uno" });
    answered(toUno, 200);
    answered(await accept(uno.jar, toUno.json.id), 200);
    answered(await setRole(ula.jar, urn, await memberIdOf(urn, "uli"), "maintainer"), 200);
    answered(await setRole(ula.jar, urn, await memberIdOf(urn, "uli"), "member"), 200);
    answered(await remove(ula.jar, urn, await memberIdOf(urn, "uno")), 200);
    expect(await rolesIn(urn)).toEqual({ uma: "owner", ula: "maintainer", uli: "member" });

    // Owners are made and unmade by owners alone, as Keel's policy says, and told so.
    const promoted = await setRole(ula.jar, urn, await memberIdOf(urn, "uli"), "owner");
    refused(promoted, 403, "OWNERS_ONLY");
    expect(promoted.json.nextActions).toEqual([
      { kind: "escalate", title: "Ask an owner: this needs that role" },
    ]);
    refused(
      await setRole(ula.jar, urn, await memberIdOf(urn, "uma"), "member"),
      403,
      "OWNERS_ONLY",
    );
    refused(await remove(ula.jar, urn, await memberIdOf(urn, "uma")), 403, "OWNERS_ONLY");
    refused(await invite(ula.jar, urn, { handle: "uno" }, "owner"), 403, "OWNERS_ONLY");
    const deleted = await call("/organization/delete", {
      body: { organizationId: urn },
      jar: ula.jar,
    });
    expect(deleted.status).toBe(403);
    expect(await rolesIn(urn)).toEqual({ uma: "owner", ula: "maintainer", uli: "member" });

    // Uli, a member, can't invite.
    const byMember = await invite(uli.jar, urn, { handle: "uno" });
    expect(byMember.status).toBe(403);
    // The owner still makes an owner.
    answered(await setRole(uma.jar, urn, await memberIdOf(urn, "uli"), "owner"), 200);
    expect(await rolesIn(urn)).toEqual({ uma: "owner", ula: "maintainer", uli: "owner" });
  });
});
