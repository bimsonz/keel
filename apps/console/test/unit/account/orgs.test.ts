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
  it("[orgs.personal] gives a user an org of their own when they choose a handle, named by it, and theirs", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await signedUp("ada@example.com", identity);
    expect(await ada.account.orgs()).toEqual([]);
    await ada.account.chooseHandle("ada");
    const who = await ada.account.who();
    const [own] = await ada.account.orgs();
    expect(own).toMatchObject({ name: "ada", handle: "ada" });
    if (who === null) throw new Error("nobody is signed in");
    expect(await ada.account.org("ada", who)).toMatchObject({
      role: "owner",
      members: [{ role: "owner", handle: "ada", you: true }],
    });
  });

  it("[orgs.create] makes an org with the reader as its owner, and a handle in use is not free", async () => {
    const { ada, grace, org } = await lovelace();
    expect(org).toEqual({ id: org.id, name: "Lovelace", handle: "lovelace" });
    expect((await ada.account.orgs()).map((held) => held.handle).toSorted()).toEqual([
      "ada",
      "lovelace",
    ]);
    expect(await ada.account.orgHandleIsFree("lovelace")).toBe(false);
    expect(await ada.account.orgHandleIsFree("babbage")).toBe(true);
    await expect(grace.account.createOrg("Mine too", "lovelace")).rejects.toThrow(Refused);
    // To someone who is not in it, an org that is there and one that is not look the same.
    expect(await grace.account.org("lovelace", grace.who)).toBeNull();
    expect(await grace.account.org("no-such-org", grace.who)).toBeNull();
  });

  it("[orgs.address] acts on the org a call names, whichever org the session holds as active", async () => {
    const { ada, org } = await lovelace();
    const own = (await ada.account.orgs()).find((held) => held.handle === "ada");
    if (own === undefined) throw new Error("no org of her own");
    // Better Auth keeps an active organisation for a session. Here it is her own org, and the page is Lovelace's.
    const set = await ada.tab.serve(`${ORIGIN}/v1/auth/organization/set-active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: own.id }),
    });
    expect(set.status).toBe(200);
    await ada.account.invite(org, { email: "new@example.com" }, "member");
    await ada.account.renameOrg(org, "Lovelace & Co");
    const there = await ada.account.org("lovelace", ada.who);
    expect(there?.org.name).toBe("Lovelace & Co");
    expect(there?.invitations.map((invitation) => invitation.to)).toEqual(["new@example.com"]);
    expect(await ada.account.org("ada", ada.who)).toMatchObject({
      org: { name: "ada" },
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
    // Answered, it is no longer an invitation.
    expect(await grace.account.invitation(invitation.id)).toBeNull();
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

  it("[roles.delete] offers deleting to an owner who has typed the org's handle, and never for a user's own org", () => {
    expect(mayDelete(org, { role: "owner", handle: "ada" }, "lovelace")).toBe(true);
    expect(mayDelete(org, { role: "owner", handle: "ada" }, "")).toBe(false);
    expect(mayDelete(org, { role: "owner", handle: "ada" }, "Lovelace")).toBe(false);
    expect(mayDelete(org, { role: "maintainer", handle: "grace" }, "lovelace")).toBe(false);
    expect(mayDelete({ handle: "ada" }, { role: "owner", handle: "ada" }, "ada")).toBe(false);
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
