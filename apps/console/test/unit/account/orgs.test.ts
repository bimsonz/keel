import { describe, expect, it } from "vitest";
import { type Org, Refused, createAccount } from "../../../src/account/account.ts";
import { givable, manages, mayDelete, roleOf } from "../../../src/account/roles.ts";
import { type Identity, createIdentity } from "../../fixtures/identity/standIn.ts";
import { ORIGIN, browser, signedUp } from "./browser.ts";

/** A person signed up on this Keel, with a handle: so with an org of their own. */
async function person(identity: Identity, handle: string) {
  const signed = await signedUp(`${handle}@example.com`, identity);
  await signed.account.chooseHandle(handle);
  const who = await signed.account.who();
  if (who === null) throw new Error("signed up, and nobody is signed in");
  return { ...signed, who };
}

/** Ada, with an org she made, and Grace, who is in no org but her own. */
async function lovelace() {
  const identity = createIdentity(ORIGIN);
  const grace = await person(identity, "grace");
  const ada = await person(identity, "ada");
  const org = await ada.account.createOrg("Lovelace", "lovelace");
  return { identity, ada, grace, org };
}

describe("an org, to its members", () => {
  it("[orgs.personal] gives a user no org when they choose a handle: the handle is their account, and no org is kept for it", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await signedUp("ada@example.com", identity);
    expect(await ada.account.orgs()).toEqual([]);
    await ada.account.chooseHandle("ada");
    const who = await ada.account.who();
    if (who === null) throw new Error("nobody is signed in");
    expect(who.handle).toBe("ada");
    expect(await ada.account.orgs()).toEqual([]);
    expect(await ada.account.org("ada", who)).toBeNull();
  });

  it("[orgs.create] makes an org with the reader as its owner, and a handle in use is not free", async () => {
    const { ada, grace, org } = await lovelace();
    expect(org).toEqual({ id: org.id, name: "Lovelace", handle: "lovelace" });
    expect((await ada.account.orgs()).map((held) => held.handle)).toEqual(["lovelace"]);
    expect(await ada.account.orgHandleIsFree("lovelace")).toBe(false);
    expect(await ada.account.orgHandleIsFree("babbage")).toBe(true);
    // An org's handle is as taken as a person's, and Keel says so in the same code and sentence.
    await expect(grace.account.createOrg("Mine too", "lovelace")).rejects.toMatchObject({
      code: "NAME_TAKEN",
      message: `"lovelace" is taken: a handle is one person's, one agent's or one org's`,
    });
    // A handle is one namespace's: an org is made with none a person has, their own included. Keel's check of a
    // slug knows only orgs, so it is Keel's refusal when the org is made that says so, in Keel's sentence.
    expect(await ada.account.orgHandleIsFree("grace")).toBe(true);
    for (const handle of ["grace", "ada", "Grace"]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another, each read on its own
      const refused: unknown = await ada.account
        .createOrg("Hers", handle)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Refused);
      expect(refused).toMatchObject({
        code: "NAME_TAKEN",
        message: `"${handle.toLowerCase()}" is taken: a handle is one person's, one agent's or one org's`,
        next: [],
      });
    }
    // Nor with a first segment Keel serves itself, in any case.
    const reserved: unknown = await ada.account
      .createOrg("Sign in", "Login")
      .catch((error: unknown) => error);
    expect(reserved).toMatchObject({
      code: "NAME_REFUSED",
      message: '"Login" is reserved',
    });
    expect((await ada.account.orgs()).map((held) => held.handle)).toEqual(["lovelace"]);
    // To someone who is not in it, an org that is there and one that is not look the same.
    expect(await grace.account.org("lovelace", grace.who)).toBeNull();
    expect(await grace.account.org("no-such-org", grace.who)).toBeNull();
  });

  it("[orgs.address] acts on the org a call names, whichever org the session holds as active", async () => {
    const { ada, org } = await lovelace();
    const other = await ada.account.createOrg("Analytical Engines", "engines");
    // Better Auth keeps an active organisation for a session. Here it is her other org, and the page is Lovelace's.
    const set = await ada.tab.serve(`${ORIGIN}/v1/auth/organization/set-active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: other.id }),
    });
    expect(set.status).toBe(200);
    await ada.account.invite(org, { email: "new@example.com" }, "member");
    await ada.account.renameOrg(org, "Lovelace & Co");
    const there = await ada.account.org("lovelace", ada.who);
    expect(there?.org.name).toBe("Lovelace & Co");
    expect(there?.invitations.map((invitation) => invitation.to)).toEqual(["new@example.com"]);
    expect(await ada.account.org("engines", ada.who)).toMatchObject({
      org: { name: "Analytical Engines" },
      invitations: [],
    });
  });

  it("[orgs.refusals] is told why an invitation is refused in Keel's own words, and by its code", async () => {
    const { ada, org } = await lovelace();
    const refused = async (invitee: { handle: string } | { email: string }): Promise<string> => {
      try {
        await ada.account.invite(org, invitee, "member");
        return "invited";
      } catch (error) {
        return error instanceof Refused ? `${error.code}: ${error.message}` : String(error);
      }
    };
    expect(await refused({ handle: "Nobody" })).toBe(
      'NO_SUCH_HANDLE: No one has the handle "Nobody"',
    );
    // A person who signed up with a passkey has an address that can never receive mail: nobody is invited at one.
    expect(await refused({ email: "someone@users.keel.invalid" })).toBe(
      "EMAIL_UNDELIVERABLE: That address can't receive mail, so no one could accept",
    );
    // A handle is read as Keel keeps it, in lower case.
    expect(await refused({ handle: "Grace" })).toBe("invited");
  });

  it("[orgs.invite] invites a user by handle, and the invitation is theirs alone to read and to accept", async () => {
    const { identity, ada, grace, org } = await lovelace();
    const invitation = await ada.account.invite(org, { handle: "grace" }, "maintainer");
    expect(invitation).toMatchObject({ role: "maintainer", to: "grace" });
    await expect(ada.account.invite(org, { handle: "nobody" }, "member")).rejects.toThrow(Refused);
    // Someone else who has the link is shown nothing of it, and cannot take it.
    const eve = await person(identity, "eve");
    expect(await eve.account.invitation(invitation.id)).toBeNull();
    await expect(eve.account.acceptInvitation(invitation.id)).rejects.toThrow(Refused);
    expect(await grace.account.invitation(invitation.id)).toEqual({
      id: invitation.id,
      org: { name: "Lovelace", handle: "lovelace" },
      role: "maintainer",
    });
    await grace.account.acceptInvitation(invitation.id);
    const there = await grace.account.org("lovelace", grace.who);
    expect(there?.role).toBe("maintainer");
    expect(there?.invitations).toEqual([]);
    expect(there?.members.map((member) => [member.role, member.you]).toSorted()).toEqual([
      ["maintainer", true],
      ["owner", false],
    ]);
    // Answered, it is no longer one she can take.
    expect(await grace.account.invitation(invitation.id)).toMatchObject({ closed: "answered" });
  });

  it("[orgs.answered] tells the person an invitation was made to that it was answered, in Keel's own words, and tells nobody else", async () => {
    const { identity, ada, grace, org } = await lovelace();
    const eve = await person(identity, "eve");
    const joined = await ada.account.invite(org, { handle: "grace" }, "member");
    await grace.account.acceptInvitation(joined.id);
    expect(await grace.account.invitation(joined.id)).toEqual({
      closed: "answered",
      said: "This invitation was already accepted",
    });
    const declined = await ada.account.invite(org, { handle: "eve" }, "member");
    await eve.account.declineInvitation(declined.id);
    expect(await eve.account.invitation(declined.id)).toEqual({
      closed: "answered",
      said: "This invitation was already rejected",
    });
    const withdrawn = await ada.account.invite(org, { handle: "eve" }, "member");
    await ada.account.cancelInvitation(withdrawn.id);
    expect(await eve.account.invitation(withdrawn.id)).toEqual({
      closed: "answered",
      said: "This invitation was already canceled",
    });
    // To anyone else each is still one that is not there: to the member who made it, and to another member.
    expect(await ada.account.invitation(joined.id)).toBeNull();
    expect(await grace.account.invitation(declined.id)).toBeNull();
    // Answering it a second time is refused in the same words.
    await expect(grace.account.acceptInvitation(joined.id)).rejects.toMatchObject({
      code: "INVITATION_ANSWERED",
      message: "This invitation was already accepted",
    });
  });

  it("[orgs.lapsed] tells them that an invitation has lapsed, in Keel's own words, and Keel takes no answer to it", async () => {
    const { identity, ada, grace, org } = await lovelace();
    const invitation = await ada.account.invite(org, { handle: "grace" }, "member");
    await identity.lapse(invitation.id);
    expect(await grace.account.invitation(invitation.id)).toEqual({
      closed: "lapsed",
      said: "This invitation has lapsed; ask the org for a new one",
    });
    await expect(grace.account.acceptInvitation(invitation.id)).rejects.toMatchObject({
      code: "INVITATION_LAPSED",
      message: "This invitation has lapsed; ask the org for a new one",
    });
    expect(await grace.account.org("lovelace", grace.who)).toBeNull();
    expect(await ada.account.invitation(invitation.id)).toBeNull();
  });

  it("[orgs.only-owner] gives an org's only owner Keel's refusal with the way forward Keel names, and lets them go once there is another owner", async () => {
    const { ada, grace, org } = await lovelace();
    const invitation = await ada.account.invite(org, { handle: "grace" }, "member");
    await grace.account.acceptInvitation(invitation.id);
    const left: unknown = await ada.account.leave(org).catch((error: unknown) => error);
    expect(left).toBeInstanceOf(Refused);
    expect(left).toMatchObject({
      code: "ONLY_OWNER",
      message:
        "An org always has an owner: make another member an owner before you leave or step down",
      next: ["Make another member an owner first"],
    });
    // A refusal Keel gives no way forward with carries none.
    const taken: unknown = await grace.account
      .createOrg("Mine too", "lovelace")
      .catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(Refused);
    expect(taken).toMatchObject({ next: [] });
    const member = (await ada.account.org("lovelace", ada.who))?.members.find((m) => !m.you);
    if (member === undefined) throw new Error("she did not join");
    await ada.account.setRole(org, member, "owner");
    await ada.account.leave(org);
    expect(await ada.account.org("lovelace", ada.who)).toBeNull();
  });

  it("[orgs.no-address] gives a page no member's address, and not the one a handle was resolved to, though Keel's answers carry them", async () => {
    const { ada, grace, org } = await lovelace();
    const first = await ada.account.invite(org, { handle: "grace" }, "member");
    const pending = await ada.account.org("lovelace", ada.who);
    await grace.account.acceptInvitation(first.id);
    const joined = await ada.account.org("lovelace", ada.who);
    const raw = await ada.tab.serve(
      `${ORIGIN}/v1/auth/organization/get-full-organization?organizationSlug=lovelace`,
    );
    expect(await raw.text()).toContain("grace@example.com");
    expect(joined?.members).toHaveLength(2);
    expect(JSON.stringify([first, pending, joined])).not.toContain("@example.com");
  });

  it("[orgs.members] lets an owner change a member's role and remove them, and a member leave", async () => {
    const { ada, grace, org } = await lovelace();
    const invitation = await ada.account.invite(org, { handle: "grace" }, "member");
    await grace.account.acceptInvitation(invitation.id);
    const member = (await ada.account.org("lovelace", ada.who))?.members.find((m) => !m.you);
    if (member === undefined) throw new Error("she did not join");
    await ada.account.setRole(org, member, "maintainer");
    expect((await grace.account.org("lovelace", grace.who))?.role).toBe("maintainer");
    await grace.account.leave(org);
    expect(await grace.account.org("lovelace", grace.who)).toBeNull();
    const again = await ada.account.invite(org, { handle: "grace" }, "member");
    await grace.account.acceptInvitation(again.id);
    const back = (await ada.account.org("lovelace", ada.who))?.members.find((m) => !m.you);
    if (back === undefined) throw new Error("she did not join again");
    await ada.account.removeMember(org, back);
    expect((await ada.account.org("lovelace", ada.who))?.members).toHaveLength(1);
  });

  it("[orgs.maintainer] holds a maintainer to Keel's rule: everything but deleting the org and making an owner", async () => {
    const { ada, grace, org } = await lovelace();
    const invitation = await ada.account.invite(org, { handle: "grace" }, "maintainer");
    await grace.account.acceptInvitation(invitation.id);
    await grace.account.renameOrg(org, "Renamed");
    await grace.account.invite(org, { email: "new@example.com" }, "member");
    const self = (await grace.account.org("lovelace", grace.who))?.members.find((m) => m.you);
    if (self === undefined) throw new Error("she did not join");
    await expect(grace.account.setRole(org, self, "owner")).rejects.toThrow(Refused);
    await expect(grace.account.deleteOrg(org)).rejects.toThrow(Refused);
    await ada.account.deleteOrg(org);
    expect(await ada.account.org("lovelace", ada.who)).toBeNull();
  });

  it("[orgs.cross-site] refuses another site's page that makes or empties an org with the user's cookies", async () => {
    const { identity, ada, grace, org } = await lovelace();
    const invitation = await ada.account.invite(org, { handle: "grace" }, "member");
    await grace.account.acceptInvitation(invitation.id);
    const member = (await ada.account.org("lovelace", ada.who))?.members.find((m) => !m.you);
    if (member === undefined) throw new Error("she did not join");
    const elsewhere = browser(identity, "https://elsewhere.example", new Map(ada.tab.jar));
    const forged = createAccount({ origin: ORIGIN, fetch: elsewhere.serve });
    await expect(forged.createOrg("Planted", "planted")).rejects.toThrow(Refused);
    await expect(forged.removeMember(org, member)).rejects.toThrow(Refused);
    await expect(forged.deleteOrg(org)).rejects.toThrow(Refused);
    expect((await ada.account.org("lovelace", ada.who))?.members).toHaveLength(2);
    expect(await ada.account.orgHandleIsFree("planted")).toBe(true);
  });
});

describe("what a role is offered", () => {
  const org: Pick<Org, "handle"> = { handle: "lovelace" };

  it("[roles.delete] offers deleting to an owner who has typed the org's handle, and to nobody else", () => {
    expect(mayDelete(org, { role: "owner" }, "lovelace")).toBe(true);
    expect(mayDelete(org, { role: "owner" }, "")).toBe(false);
    expect(mayDelete(org, { role: "owner" }, "Lovelace")).toBe(false);
    expect(mayDelete(org, { role: "maintainer" }, "lovelace")).toBe(false);
  });

  it("[roles.offered] offers the members' controls to an owner and a maintainer, and an owner's role only to an owner", () => {
    expect([manages("owner"), manages("maintainer"), manages("member")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(givable("owner")).toEqual(["owner", "maintainer", "member"]);
    expect(givable("maintainer")).toEqual(["maintainer", "member"]);
    expect(givable("member")).toEqual([]);
    expect([roleOf("maintainer"), roleOf("admin"), roleOf("")]).toEqual([
      "maintainer",
      "member",
      "member",
    ]);
  });
});
