import { describe, expect, it } from "vitest";
import type { Member } from "../../../src/account/account.ts";
import {
  GRANTS,
  SCOPES,
  givenOf,
  handleFor,
  inviterOf,
  joinedOf,
  mayRemove,
  removalOf,
  sponsoredMatching,
  standingOf,
} from "../../../src/account/orgAgents.ts";
import type { AgentCard, NamespaceAgent, Scope } from "../../../src/contract/keel/index.ts";
import { createHttpOrgAgents, createHttpSponsorship } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import { createIdentity } from "../../fixtures/identity/standIn.ts";
import { SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";
import { ORIGIN, browser, signedUp } from "./browser.ts";

const OTTER: AgentCard = {
  id: "agt_000000000000000000000OTTER",
  name: "Tidy Otter",
  handle: "tidy-otter",
};
const HERON: AgentCard = {
  id: "agt_000000000000000000000HERON",
  name: "Quiet Heron",
  handle: "quiet-heron",
};
/** An agent a member enrolled: it has no handle, so no invitation can name it. */
const BETA: AgentCard = { id: "agt_0000000000000000000000BETA", name: "beta", kind: "hosted" };

type Person = "ada" | "eve" | "grace" | "hedy" | "mary";

/**
 * A Keel whose org `acme` has four members: Ada its owner, Mary a maintainer, Grace and Hedy plain members.
 * Eve is in no org. Everyone has signed in by a passkey just now but Hedy, whose sign-in is stale. The
 * browser's part is played here: it sends a session's cookie and the page's origin, and what the page's own
 * code put on each request is kept as it was sent.
 */
function keel() {
  const fake = createFakeKeel({
    agents: [OTTER, HERON, BETA],
    sessions: {
      ada: "owner",
      mary: "maintainer",
      grace: "member",
      hedy: "member",
      eve: "stranger",
    },
    freshly: ["ada", "mary", "grace", "eve"],
    whose: (handle) =>
      handle === "acme"
        ? { id: "org_0000000000000000000000ACME", kind: "org" }
        : handle === "ada"
          ? { id: "ada", kind: "user" }
          : undefined,
    now: () => Date.parse("2026-10-13T19:00:00.000Z"),
  });
  const fromThePage: Request[] = [];
  const serve = (who?: Person) => (asked: Request) => {
    const headers = new Headers(asked.headers);
    if (who !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${who}`);
    headers.set("origin", ORIGIN);
    return fake.fetch(new Request(asked, { headers }));
  };
  const as = (who?: Person) =>
    createHttpOrgAgents({
      origin: ORIGIN,
      fetch: (input, init) => {
        const asked = new Request(input, init);
        fromThePage.push(asked.clone());
        return serve(who)(asked);
      },
    });
  /** A move sent with a key of the test's choosing, as a client that keeps its key for a second try sends it. */
  const keyed = async (who: Person, key: string, agent: string, scopes: readonly Scope[]) => {
    const response = await serve(who)(
      new Request(`${ORIGIN}/v1/namespaces/acme/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ agent, scopes }),
      }),
    );
    const body: { code?: string; state?: string } = await response.json();
    return `${response.status} ${body.code ?? body.state ?? ""}`;
  };
  /** Keel's card of an agent, as this reader is read it. */
  const card = (who: Person | undefined, agentId: string) =>
    createHttpSponsorship({
      origin: ORIGIN,
      fetch: (input, init) => serve(who)(new Request(input, init)),
    }).findAgent(agentId);
  return { fake, fromThePage, as, keyed, card };
}

/** A refusal in full: Keel's sentence and the ways forward it gave under it, as a page shows them. */
const worded = (error: unknown): unknown =>
  error instanceof KeelRefused
    ? { status: error.status, code: error.code, said: error.message, next: error.next }
    : error;

const STALE = {
  status: 403,
  code: "auth.fresh_sign_in_required",
  said: "This needs a fresh sign-in: a passkey sign-in from the last ten minutes.",
  next: ["Sign in again with your passkey, then retry"],
};
const NOT_THERE = { status: 404, code: "resource.not_found", next: [] };

const row = (over: Partial<NamespaceAgent> = {}): NamespaceAgent => ({
  id: OTTER.id,
  name: "Tidy Otter",
  handle: "tidy-otter",
  state: "joined",
  ...over,
});
const member = (over: Partial<Member>): Member => ({
  id: "mem_1",
  userId: "usr_1",
  role: "member",
  name: "Ada",
  you: false,
  ...over,
});

/** Keel's profile of an agent the reader sponsors, as `listSponsored` answers it. */
const profile = (id: string, name: string, handle?: string) => ({
  id,
  name,
  ...(handle === undefined ? {} : { handle }),
  scopes: [],
  revocationEpoch: 0,
  createdAt: "2026-10-14T20:00:00.000Z",
});

describe("the agents in an org", () => {
  it("[org-agents.read] are read to a member with the invitations not yet answered, what each gives and whose it is, and to anyone else as the ones that joined and who each is", async () => {
    const k = keel();
    await k.as("grace").inviteAgent("acme", "tidy-otter", SCOPES.read);
    await k.as("ada").inviteAgent("acme", "quiet-heron", SCOPES.work);
    k.fake.accepts("acme", HERON.id);
    expect(await k.as("hedy").listAgents("acme")).toEqual([
      {
        id: OTTER.id,
        name: "Tidy Otter",
        handle: "tidy-otter",
        state: "invited",
        scopes: ["agent:read"],
        invitedBy: "grace",
        invitedAt: "2026-10-13T19:00:00.000Z",
      },
      {
        id: HERON.id,
        name: "Quiet Heron",
        handle: "quiet-heron",
        state: "joined",
        scopes: ["agent:read", "agent:work"],
        invitedBy: "ada",
        invitedAt: "2026-10-13T19:00:00.000Z",
        joinedAt: "2026-10-13T19:00:00.000Z",
      },
    ]);
    // Someone signed in who is no member, and a visitor: the agent that joined, and nothing of who invited it.
    const joined = [
      {
        id: HERON.id,
        name: "Quiet Heron",
        handle: "quiet-heron",
        state: "joined",
        joinedAt: "2026-10-13T19:00:00.000Z",
      },
    ];
    expect(await k.as("eve").listAgents("acme")).toEqual(joined);
    expect(await k.as(undefined).listAgents("acme")).toEqual(joined);
    // A person's own namespace has none, and a handle nobody has is not there.
    expect(await k.as("ada").listAgents("ada")).toEqual([]);
    expect(await k.as("ada").listAgents("nobody").catch(worded)).toMatchObject(NOT_THERE);
  });

  it("[org-agents.calls] asks Keel for an invitation and a removal by its own operations, with the scopes chosen, a key made for the one attempt and no credential of the page's", async () => {
    const k = keel();
    const invited = await k.as("grace").inviteAgent("acme", "tidy-otter", SCOPES.read);
    expect(invited).toMatchObject({ id: OTTER.id, state: "invited", scopes: ["agent:read"] });
    await k.as("grace").inviteAgent("acme", "quiet-heron", SCOPES.work);
    const ended = await k.as("grace").removeAgent("acme", OTTER.id);
    expect(ended).toMatchObject({ id: OTTER.id, state: "ended", invitedBy: "grace" });
    await k.as("grace").listAgents("acme");

    const sent = await Promise.all(
      k.fromThePage.map(async (request) => ({
        line: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.text(),
        key: request.headers.get("idempotency-key") ?? "",
      })),
    );
    expect(sent.map((request) => `${request.line} ${request.body}`)).toEqual([
      'POST /v1/namespaces/acme/agents {"agent":"tidy-otter","scopes":["agent:read"]}',
      'POST /v1/namespaces/acme/agents {"agent":"quiet-heron","scopes":["agent:read","agent:work"]}',
      `DELETE /v1/namespaces/acme/agents/${OTTER.id} `,
      "GET /v1/namespaces/acme/agents ",
    ]);
    expect(sent.map((request) => request.key.replace(/[0-9a-f-]{36}$/, "<uuid>"))).toEqual([
      "console:invite-agent:<uuid>",
      "console:invite-agent:<uuid>",
      "console:remove-agent:<uuid>",
      "",
    ]);
    expect(new Set(sent.map((request) => request.key)).size).toBe(4);
    // The session is the browser's to send: the page adds no credential of its own.
    expect(
      k.fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);
  });

  it("[org-agents.refused] hands on Keel's refusals of an invitation as Keel gives them, in its order: no session, a handle that is none, a namespace that is no org, no member, a stale sign-in, scopes it does not give, no such agent, an agent somebody answers for", async () => {
    const k = keel();
    const tried = (who: Person | undefined, org: string, agent: string, scopes: readonly Scope[]) =>
      k
        .as(who)
        .inviteAgent(org, agent, scopes)
        .then(() => "invited", worded);
    expect(await tried(undefined, "acme", "tidy-otter", SCOPES.work)).toMatchObject({
      status: 401,
      code: "auth.required",
    });
    // What could be no handle is refused by Keel's validators before anything is said of the org or the reader.
    expect(await tried("eve", "nobody", "Tidy Otter", SCOPES.work)).toMatchObject({
      status: 400,
      code: "request.invalid",
    });
    // A person's own namespace takes no invitation, and reads as one that is not there, to its owner too.
    expect(await tried("ada", "ada", "tidy-otter", SCOPES.work)).toMatchObject(NOT_THERE);
    expect(await tried("eve", "nobody", "tidy-otter", SCOPES.work)).toMatchObject(NOT_THERE);
    // No member, though signed in afresh: told who to ask, before the scopes or the agent are looked at.
    expect(await tried("eve", "acme", "nobody-at-all", ["agent:work"])).toEqual({
      status: 403,
      code: "auth.forbidden",
      said: "Refused: role.",
      next: ["Ask a member: this needs that role"],
    });
    // A member whose sign-in is stale, whatever else is wrong with what they asked.
    expect(await tried("hedy", "acme", "nobody-at-all", ["agent:work"])).toEqual(STALE);
    // To work without reading, or a scope named twice, before the agent is looked for.
    const SCOPES_REFUSED = {
      status: 400,
      code: "request.invalid",
      said: "An invitation gives agent:read, or agent:read and agent:work, each named once.",
      next: [],
    };
    expect(await tried("grace", "acme", "nobody-at-all", ["agent:work"])).toEqual(SCOPES_REFUSED);
    expect(await tried("grace", "acme", "tidy-otter", ["agent:read", "agent:read"])).toEqual(
      SCOPES_REFUSED,
    );
    // A handle no agent has: nobody's, a person's, and an agent a member enrolled, which has none.
    for (const handle of ["nobody-at-all", "ada", "beta"])
      // oxlint-disable-next-line no-await-in-loop -- three asks, one after the other
      expect(await tried("grace", "acme", handle, SCOPES.work)).toEqual({
        ...NOT_THERE,
        said: `No agent has the handle ${handle}.`,
      });
    expect(await k.as("grace").listAgents("acme")).toEqual([]);

    // One member answers for an agent in an org: another member's invitation of it is refused, and so is the
    // same member's for something else. The same member asking the same again is answered the row as it stands.
    expect(await tried("grace", "acme", "tidy-otter", SCOPES.read)).toBe("invited");
    const HELD = {
      status: 409,
      code: "invitation.state_refused",
      said: `${OTTER.id} already has an invitation here, and one member answers for an agent in an org. Take it out first to invite it again or to change what it may do.`,
      next: ["Read the org's agents and who invited each"],
    };
    expect(await tried("ada", "acme", "tidy-otter", SCOPES.read)).toEqual(HELD);
    expect(await tried("grace", "acme", "tidy-otter", SCOPES.work)).toEqual(HELD);
    k.fake.accepts("acme", OTTER.id);
    expect(await k.as("grace").inviteAgent("acme", "tidy-otter", SCOPES.read)).toMatchObject({
      state: "joined",
      scopes: ["agent:read"],
      invitedBy: "grace",
    });
    expect(await k.as("ada").listAgents("acme")).toHaveLength(1);
  });

  it("[org-agents.remove] takes a removal from the member who invited the agent, from a maintainer and from an owner, on a fresh sign-in, and tells anyone else who to ask whether or not the agent is there", async () => {
    const k = keel();
    await k.as("grace").inviteAgent("acme", "tidy-otter", SCOPES.work);
    await k.as("ada").inviteAgent("acme", "quiet-heron", SCOPES.read);
    k.fake.accepts("acme", HERON.id);
    const tried = (who: Person | undefined, agentId: string) =>
      k
        .as(who)
        .removeAgent("acme", agentId)
        .then((answered) => answered.state, worded);
    const ASK = {
      status: 403,
      code: "auth.forbidden",
      said: "Refused: role.",
      next: ["Ask a maintainer or an owner: this needs that role"],
    };
    expect(await tried(undefined, OTTER.id)).toMatchObject({ status: 401, code: "auth.required" });
    // A plain member who did not invite it, someone in no org, and a member asking of an agent with no place.
    expect(await tried("grace", HERON.id)).toEqual(ASK);
    expect(await tried("eve", OTTER.id)).toEqual(ASK);
    expect(await tried("grace", BETA.id)).toEqual(ASK);
    // A stale sign-in is told so only once the reader is one Keel would take it from.
    expect(await tried("hedy", OTTER.id)).toEqual(ASK);
    expect(await k.as("ada").listAgents("acme")).toHaveLength(2);
    // The member who invited it withdraws an invitation nobody answered.
    expect(await tried("grace", OTTER.id)).toBe("ended");
    // A maintainer takes out one that joined, and is told an agent with no place here is not there.
    expect(await tried("mary", HERON.id)).toBe("ended");
    expect(await tried("mary", HERON.id)).toMatchObject(NOT_THERE);
    expect(await tried("ada", BETA.id)).toMatchObject(NOT_THERE);
    // An ended row is in no list, to a member either, and the agent may be invited again: by anyone, last.
    expect(await k.as("ada").listAgents("acme")).toEqual([]);
    await k.as("mary").inviteAgent("acme", "quiet-heron", SCOPES.work);
    await k.as("ada").inviteAgent("acme", "tidy-otter", SCOPES.read);
    expect(
      (await k.as("grace").listAgents("acme")).map((agent) => `${agent.handle} ${agent.invitedBy}`),
    ).toEqual(["quiet-heron mary", "tidy-otter ada"]);
  });

  it("[org-agents.card] are named the orgs they have joined on their own card, to anyone: none while an invitation waits, none once taken out, and never who invited them", async () => {
    const k = keel();
    await k.as("grace").inviteAgent("acme", "tidy-otter", SCOPES.work);
    // An invitation nobody has answered is on no card, and a card with no org has no list of them.
    expect(await k.card(undefined, OTTER.id)).toEqual(OTTER);
    k.fake.accepts("acme", OTTER.id);
    const joined = { ...OTTER, orgs: [{ handle: "acme", kind: "org" }] };
    expect(await k.card(undefined, OTTER.id)).toEqual(joined);
    // The same card whoever reads it: the member who invited it is told no more there than a visitor.
    expect(await k.card("grace", OTTER.id)).toEqual(joined);
    expect(await k.card("eve", OTTER.id)).toEqual(joined);
    expect(await k.card(undefined, HERON.id)).toEqual(HERON);
    await k.as("ada").removeAgent("acme", OTTER.id);
    expect(await k.card(undefined, OTTER.id)).toEqual(OTTER);
  });

  it("[org-agents.stale] is refused a removal from a sign-in that is not fresh, in Keel's sentence with its way forward, and nothing is changed", async () => {
    // An owner, whose sign-in is stale: told so before Keel says whether the agent has a place.
    const fake = createFakeKeel({
      agents: [OTTER],
      sessions: { ada: "owner" },
      freshly: [],
    });
    const stale = createHttpOrgAgents({
      origin: ORIGIN,
      fetch: (input, init) => {
        const headers = new Headers(new Request(input, init).headers);
        headers.set("cookie", `${SESSION_COOKIE}=ada`);
        headers.set("origin", ORIGIN);
        return fake.fetch(new Request(new Request(input, init), { headers }));
      },
    });
    expect(await stale.inviteAgent("acme", "tidy-otter", SCOPES.work).catch(worded)).toEqual(STALE);
    expect(await stale.removeAgent("acme", OTTER.id).catch(worded)).toEqual(STALE);
    expect(await stale.listAgents("acme")).toEqual([]);
  });

  it("[org-agents.key] answers the same invitation asked again under its key as it was, and refuses the key on another", async () => {
    const k = keel();
    expect(await k.keyed("grace", "key-one-of-grace", "tidy-otter", SCOPES.read)).toBe(
      "201 invited",
    );
    expect(await k.keyed("grace", "key-one-of-grace", "tidy-otter", SCOPES.read)).toBe(
      "201 invited",
    );
    expect(await k.keyed("grace", "key-one-of-grace", "tidy-otter", SCOPES.work)).toBe(
      "409 request.idempotency_conflict",
    );
    // A key too short to be one is Keel's validators' to refuse.
    expect(await k.keyed("grace", "short", "quiet-heron", SCOPES.read)).toBe("400 request.invalid");
    // Another site's page, with the member's cookie, is refused before anything is read.
    const crossed = await k.fake.fetch(
      new Request(`${ORIGIN}/v1/namespaces/acme/agents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "key-two-of-grace",
          cookie: `${SESSION_COOKIE}=grace`,
          origin: "https://elsewhere.example",
        },
        body: JSON.stringify({ agent: "quiet-heron" }),
      }),
    );
    expect(crossed.status).toBe(403);
    expect(await k.as("ada").listAgents("acme")).toHaveLength(1);
  });

  it("[org-agents.inviter] names who invited an agent from the org's own members by the account Keel's row names, and says so where that account is no longer a member", async () => {
    const identity = createIdentity(ORIGIN);
    const keelOf = createFakeKeel({
      agents: [OTTER],
      whose: (handle) => identity.whose(handle),
      roleIn: (userId, org) => identity.roleIn(userId, org),
      readerOf: (request) => identity.reads(request),
    });
    const person = async (handle: string) => {
      const signed = await signedUp(`${handle}@example.com`, identity);
      await signed.account.chooseHandle(handle);
      const who = await signed.account.who();
      if (who === null) throw new Error("signed up, and nobody is signed in");
      await identity.touched(who.id);
      // The same browser, and so the same cookies, asks Keel.
      const tab = browser({ handle: (request) => keelOf.fetch(request) }, ORIGIN, signed.tab.jar);
      return { ...signed, who, agents: createHttpOrgAgents({ origin: ORIGIN, fetch: tab.serve }) };
    };
    const ada = await person("ada");
    const grace = await person("grace");
    const org = await ada.account.createOrg("Lovelace", "lovelace");
    const invitation = await ada.account.invite(org, { handle: "grace" }, "member");
    await grace.account.acceptInvitation(invitation.id);

    // Any member invites: Grace is a plain one.
    await grace.agents.inviteAgent("lovelace", "tidy-otter", SCOPES.work);
    keelOf.accepts("lovelace", OTTER.id);
    const said = async (reader: typeof ada) => {
      const page = await reader.account.org("lovelace", reader.who);
      const [listed] = await reader.agents.listAgents("lovelace");
      if (page === null || listed === undefined) throw new Error("no org, or no agent in it");
      return inviterOf(listed, page.members);
    };
    expect(await said(grace)).toBe("Invited by you");
    expect(await said(ada)).toBe("Invited by @grace");
    // Keel keeps the row as it was when its inviter leaves, and its gate lets the agent do nothing there.
    await grace.account.leave(org);
    expect(await said(ada)).toBe("Inactive: inviter left the org");
    expect(await grace.agents.listAgents("lovelace")).toEqual([
      {
        id: OTTER.id,
        name: "Tidy Otter",
        handle: "tidy-otter",
        state: "joined",
        joinedAt: expect.any(String),
      },
    ]);
  });

  it("[org-agents.words] says what an invitation gives, where it stands and what taking it out is called, each from Keel's own field", () => {
    expect(GRANTS.map((offered) => `${offered.label}: ${SCOPES[offered.grant].join(" ")}`)).toEqual(
      ["Write: agent:read agent:work", "Read: agent:read"],
    );
    expect(givenOf(row({ scopes: ["agent:read", "agent:work"] }))).toBe("Write");
    expect(givenOf(row({ scopes: ["agent:read"] }))).toBe("Read");
    // Keel names no scopes to anyone but a member, and the row then says nothing of them.
    expect(givenOf(row())).toBe("");
    expect(standingOf(row({ state: "invited" }))).toBe("Pending");
    expect(standingOf(row({ joinedAt: "2026-10-13T19:00:00.000Z" }))).toBe("Joined 2026-10-13");
    expect(standingOf(row())).toBe("Joined");
    expect(standingOf(row({ state: "ended" }))).toBe("Ended");
    expect(removalOf(row({ state: "invited" }))).toBe("Cancel invitation");
    expect(removalOf(row())).toBe("Remove");
    expect(
      joinedOf([
        row({ id: "a", state: "invited" }),
        row({ id: "b" }),
        row({ id: "c", state: "ended" }),
      ]).map((agent) => agent.id),
    ).toEqual(["b"]);
  });

  it("[org-agents.whose] names the inviter by handle, by name where they have none, as you where it is the reader, and as nobody where the row names none", () => {
    const members = [
      member({ userId: "usr_ada", handle: "ada", name: "Ada L" }),
      member({ id: "mem_2", userId: "usr_grace", name: "Grace H" }),
      member({ id: "mem_3", userId: "usr_hedy", handle: "hedy", you: true }),
    ];
    expect(inviterOf(row({ invitedBy: "usr_ada" }), members)).toBe("Invited by @ada");
    expect(inviterOf(row({ invitedBy: "usr_grace" }), members)).toBe("Invited by Grace H");
    expect(inviterOf(row({ invitedBy: "usr_hedy" }), members)).toBe("Invited by you");
    // A membership's own id is not an account's: a row is never matched by it.
    expect(inviterOf(row({ invitedBy: "mem_1" }), members)).toBe("Inactive: inviter left the org");
    expect(inviterOf(row(), members)).toBe("");
  });

  it("[org-agents.offered] offers a row's removal to whoever Keel would take it from: the member who invited it, a maintainer and an owner", () => {
    const theirs = row({ invitedBy: "usr_grace" });
    expect(mayRemove(theirs, "member", "usr_grace")).toBe(true);
    expect(mayRemove(theirs, "member", "usr_hedy")).toBe(false);
    expect(mayRemove(theirs, "maintainer", "usr_hedy")).toBe(true);
    expect(mayRemove(theirs, "owner", "usr_hedy")).toBe(true);
    // A row that names nobody is a non-member's read, and no member's to take out.
    expect(mayRemove(row(), "member", "usr_grace")).toBe(false);
  });

  it("[org-agents.offered] with nothing typed, offers every agent the reader sponsors that the org has not invited and that has not joined", () => {
    const sponsored = [
      profile("agt_A", "keelbot", "agent-k3e1b0t7"),
      profile("agt_B", "Tidy Otter", "tidy-otter"),
      profile("agt_C", "keel-hosted"),
    ];
    const offered = (typed: string, listed: NamespaceAgent[] = []) =>
      sponsoredMatching(sponsored, typed, listed).map((agent) => agent.name);
    expect(offered("")).toEqual(["keelbot", "Tidy Otter"]);
    expect(offered("  ")).toEqual(["keelbot", "Tidy Otter"]);
    // An agent invited, or one that has joined, is the org's already; one whose membership ended may be asked again.
    expect(offered("", [row({ id: "agt_B", state: "joined" })])).toEqual(["keelbot"]);
    expect(offered("", [row({ id: "agt_A", state: "invited" })])).toEqual(["Tidy Otter"]);
    expect(offered("", [row({ id: "agt_A", state: "ended" })])).toEqual(["keelbot", "Tidy Otter"]);
    expect(offered("otter", [row({ id: "agt_B", state: "joined" })])).toEqual([]);
  });

  it("[org-agents.find] finds an agent the reader sponsors by its handle or its name, and invites a name typed whole by its handle", () => {
    const sponsored = [
      profile("agt_A", "keelbot", "agent-k3e1b0t7"),
      profile("agt_B", "Tidy Otter", "tidy-otter"),
      // Enrolled by a person: it has no handle, so it cannot be invited and is never found.
      profile("agt_C", "keel-hosted"),
    ];
    const names = (typed: string) => sponsoredMatching(sponsored, typed).map((agent) => agent.name);
    expect(names("keel")).toEqual(["keelbot"]);
    expect(names("KEELBOT")).toEqual(["keelbot"]);
    expect(names("otter")).toEqual(["Tidy Otter"]);
    expect(names("agent-k3")).toEqual(["keelbot"]);
    expect(names("t")).toEqual(["keelbot", "Tidy Otter"]);
    expect(names("nobody")).toEqual([]);
    // A handle typed whole is chosen: nothing is offered under it.
    expect(names("tidy-otter")).toEqual([]);

    expect(handleFor(sponsored, "keelbot")).toBe("agent-k3e1b0t7");
    expect(handleFor(sponsored, " Tidy otter ")).toBe("tidy-otter");
    expect(handleFor(sponsored, "tidy-otter")).toBe("tidy-otter");
    // Anything else goes to Keel as typed, trimmed, for Keel to answer.
    expect(handleFor(sponsored, " someone-else ")).toBe("someone-else");
    expect(handleFor(sponsored, "keel-hosted")).toBe("keel-hosted");
    // Two agents of one name are not chosen between.
    expect(handleFor([...sponsored, profile("agt_D", "keelbot", "agent-other")], "keelbot")).toBe(
      "keelbot",
    );
  });
});
