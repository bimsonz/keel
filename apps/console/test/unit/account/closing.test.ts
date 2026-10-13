import { describe, expect, it } from "vitest";
import { Refused } from "../../../src/account/account.ts";
import { mayClose, standingOf } from "../../../src/account/closing.ts";
import { type Identity, createIdentity } from "../../fixtures/identity/standIn.ts";
import { ORIGIN, signedUp } from "./browser.ts";

/** A person with a handle and a passkey, whose sign-in is by that passkey just now unless `stale`. */
async function person(identity: Identity, handle: string, stale = false) {
  const signed = await signedUp(`${handle}@example.com`, identity);
  await signed.account.chooseHandle(handle);
  const who = await signed.account.who();
  if (who === null) throw new Error("signed up, and nobody is signed in");
  await identity.keyed(who.id, "This laptop");
  if (!stale) await identity.touched(who.id);
  return { ...signed, who };
}

const refusedOf = async (asked: Promise<void>): Promise<Refused> => {
  const answer: unknown = await asked.catch((error: unknown) => error);
  if (!(answer instanceof Refused)) throw new Error("Keel did not refuse");
  return answer;
};

const FORWARD = "Make another member an owner first";

describe("deleting an account", () => {
  it("[closing.typed] is offered once the person has typed their handle, exactly, and to nobody with no handle", () => {
    const ada = { handle: "ada" };
    expect(mayClose(ada, "ada")).toBe(true);
    expect(
      ["", "ad", "adal", "Ada", " ada", "ada "].filter((typed) => mayClose(ada, typed)),
    ).toEqual([]);
    expect(mayClose({}, "")).toBe(false);
  });

  it("[closing.body] asks Keel with an empty body and no credential of the page's, and Keel refuses a password or a token sent with it", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await person(identity, "ada");
    const grace = await person(identity, "grace");
    await ada.account.deleteAccount();
    const sent = ada.tab.fromThePage.at(-1);
    expect([sent?.method, new URL(sent?.url ?? ORIGIN).pathname]).toEqual([
      "POST",
      "/v1/auth/delete-user",
    ]);
    expect(await sent?.json()).toEqual({});
    expect([sent?.headers.get("authorization"), sent?.headers.get("cookie")]).toEqual([null, null]);
    // What the page never sends, Keel refuses before anything else, and deletes nobody.
    for (const body of [{ password: "hunter2" }, { token: "a-token" }]) {
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      const answer = await grace.tab.serve(`${ORIGIN}/v1/auth/delete-user`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // oxlint-disable-next-line no-await-in-loop -- two, in order
      expect([answer.status, await answer.json()]).toEqual([
        400,
        {
          code: "PASSKEY_ONLY",
          message:
            "Keel deletes an account on a fresh passkey sign-in alone: send no password and no token",
        },
      ]);
    }
    expect(await identity.whose("grace")).toEqual({ id: grace.who.id, kind: "user" });
  });

  it("[closing.deleted] deletes the account of whoever asks, signed in by their passkey just now, and nobody else's", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await person(identity, "ada");
    const grace = await person(identity, "grace");
    await ada.account.deleteAccount();
    expect(await ada.account.who()).toBeNull();
    expect(await identity.whose("ada")).toBeUndefined();
    expect(await grace.account.who()).toEqual(grace.who);
    expect(await identity.whose("grace")).toEqual({ id: grace.who.id, kind: "user" });
  });

  it("[closing.kept] keeps a deleted person's handle for good: nobody chooses it and no org is made with it, as Keel refuses any held handle", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await person(identity, "ada");
    await ada.account.deleteAccount();
    const TAKEN = {
      code: "NAME_TAKEN",
      message: `"ada" is taken: a handle is one person's, one agent's or one org's`,
    };
    const grace = await signedUp("grace@example.com", identity);
    expect(await refusedOf(grace.account.chooseHandle("Ada"))).toMatchObject(TAKEN);
    expect((await grace.account.who())?.handle).toBeUndefined();
    await grace.account.chooseHandle("grace");
    const made: unknown = await grace.account
      .createOrg("Hers now", "ada")
      .catch((error: unknown) => error);
    expect(made).toMatchObject(TAKEN);
    expect(await identity.whose("ada")).toBeUndefined();
    // A handle nobody ever held is free, to a person and to an org.
    await grace.account.createOrg("Engines", "engines");
    expect(await identity.whose("engines")).toMatchObject({ kind: "org" });
  });

  it("[closing.stale] is refused from a sign-in that is not fresh, in Keel's sentence for this person, and deletes nothing", async () => {
    const identity = createIdentity(ORIGIN);
    // Ada's passkey sign-in is more than ten minutes old. Grace has no passkey at all.
    const ada = await person(identity, "ada");
    await identity.age();
    const grace = await signedUp("grace@example.com", identity);
    await grace.account.chooseHandle("grace");
    expect(await refusedOf(ada.account.deleteAccount())).toMatchObject({
      code: "FRESH_SIGN_IN_REQUIRED",
      message:
        "Sign in again with your passkey, then retry: deleting your account needs a passkey sign-in from the last ten minutes",
      standing: { projects: [], orgs: [] },
    });
    expect(await refusedOf(grace.account.deleteAccount())).toMatchObject({
      code: "FRESH_SIGN_IN_REQUIRED",
      message:
        "Add a passkey first, then retry: deleting your account needs a passkey sign-in from the last ten minutes",
    });
    expect(await identity.whose("ada")).toEqual({ id: ada.who.id, kind: "user" });
    expect(await identity.whose("grace")).toEqual({ id: grace.who.id, kind: "user" });
    // Another change to how an account signs in keeps its own sentence.
    expect(await refusedOf(ada.account.addPasskey("Another"))).toMatchObject({
      message:
        "Sign in again with your passkey, then retry: changing how you sign in needs a passkey sign-in from the last ten minutes",
    });
    // Signed in by the passkey again, the same call deletes.
    await identity.touched(ada.who.id);
    await ada.account.deleteAccount();
    expect(await identity.whose("ada")).toBeUndefined();
  });

  it("[closing.owned] hands a page each project Keel named in refusing an account that owns one, and the account is still there", async () => {
    const owned = new Map<string, string[]>();
    const identity = createIdentity(ORIGIN, { projectsOf: (id) => owned.get(id) ?? [] });
    const ada = await person(identity, "ada");
    const grace = await person(identity, "grace");
    owned.set(ada.who.id, ["demo", "engine"]);
    owned.set(grace.who.id, ["notes"]);
    const both = await refusedOf(ada.account.deleteAccount());
    expect(both).toMatchObject({
      code: "OWNS_PROJECTS",
      message:
        "Your account owns projects (demo, engine), and an account that owns one is not deleted here: email privacy@keel.town and we'll delete it",
      next: [],
    });
    expect(both.standing).toEqual({ projects: ["demo", "engine"], orgs: [] });
    const one = await refusedOf(grace.account.deleteAccount());
    expect(one.message).toBe(
      "Your account owns a project (notes), and an account that owns one is not deleted here: email privacy@keel.town and we'll delete it",
    );
    expect(one.standing).toEqual({ projects: ["notes"], orgs: [] });
    expect(await ada.account.who()).toEqual(ada.who);
    expect(await identity.whose("ada")).toEqual({ id: ada.who.id, kind: "user" });
  });

  it("[closing.only-owner] hands a page each org Keel named in refusing an org's one owner, with Keel's way forward for it, and no org another owner holds", async () => {
    const identity = createIdentity(ORIGIN);
    const ada = await person(identity, "ada");
    const grace = await person(identity, "grace");
    const lovelace = await ada.account.createOrg("Lovelace", "lovelace");
    const engines = await ada.account.createOrg("Engines", "engines");
    const shared = await ada.account.createOrg("Shared", "shared");
    const invited = await ada.account.invite(shared, { handle: "grace" }, "owner");
    await grace.account.acceptInvitation(invited.id);
    const answer = await refusedOf(ada.account.deleteAccount());
    expect(answer).toMatchObject({
      code: "ONLY_OWNER",
      message:
        "An org always has an owner: make another member an owner of engines, lovelace before you delete your account",
      next: [FORWARD, FORWARD],
    });
    expect(answer.standing).toEqual({
      projects: [],
      orgs: [
        { id: engines.id, handle: "engines", next: FORWARD },
        { id: lovelace.id, handle: "lovelace", next: FORWARD },
      ],
    });
    expect(await identity.whose("ada")).toEqual({ id: ada.who.id, kind: "user" });
    // Grace owns an org too, and Ada owns it with her: nothing stands in Grace's way.
    await grace.account.deleteAccount();
    expect(await identity.whose("grace")).toBeUndefined();
  });

  it("[closing.named] reads each org's way forward by the org Keel's action names, and nothing that is not a name", () => {
    expect(
      standingOf({
        projects: ["demo", 3, null],
        orgs: [{ id: "o1", slug: "one" }, { id: "o2", slug: "two" }, { slug: "no-id" }, "three"],
        nextActions: [
          { title: "For two", args: { organizationId: "o2" } },
          { title: "For nobody here", args: { organizationId: "o9" } },
          { title: "Names no org" },
        ],
      }),
    ).toEqual({
      projects: ["demo"],
      orgs: [
        { id: "o1", handle: "one" },
        { id: "o2", handle: "two", next: "For two" },
      ],
    });
    expect(standingOf({})).toEqual({ projects: [], orgs: [] });
  });

  it("[closing.order] refuses in Keel's order: a sign-in that is not fresh, then the projects, then the orgs", async () => {
    const owned = new Map<string, string[]>();
    const identity = createIdentity(ORIGIN, { projectsOf: (id) => owned.get(id) ?? [] });
    const ada = await person(identity, "ada", true);
    await ada.account.createOrg("Lovelace", "lovelace");
    owned.set(ada.who.id, ["demo"]);
    expect((await refusedOf(ada.account.deleteAccount())).code).toBe("FRESH_SIGN_IN_REQUIRED");
    await identity.touched(ada.who.id);
    expect((await refusedOf(ada.account.deleteAccount())).code).toBe("OWNS_PROJECTS");
    owned.delete(ada.who.id);
    expect((await refusedOf(ada.account.deleteAccount())).code).toBe("ONLY_OWNER");
  });
});
