import { afterEach, describe, expect, it, vi } from "vitest";
import type { Who } from "../../../src/account/account.ts";
import { linkOf, takeLink } from "../../../src/account/sponsorLink.ts";
import { spent, standBehind } from "../../../src/account/sponsoring.ts";
import type { AgentCard } from "../../../src/contract/keel/index.ts";
import { hrefOf, placeOf, sentFrom } from "../../../src/places.ts";
import { parse } from "../../../src/route.ts";
import { createHttpSponsorship } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import {
  SESSION_COOKIE,
  SPONSOR_CODE_FOR_MS,
  SPONSOR_HELD,
  createFakeKeel,
} from "../../fixtures/mock/fakeKeel.ts";

const ORIGIN = "https://keel.example";
const AGENT: AgentCard = {
  id: "agt_0000000000000000000000BETA",
  name: "beta",
  kind: "hosted",
  namespace: "acme",
};
const ADA: Who = { id: "ada", name: "Ada", handle: "ada" };
const GRACE: Who = { id: "grace", name: "Grace", handle: "grace" };

/**
 * A Keel that knows one agent, and two people's sessions: Ada's signed in by a passkey just now, Grace's stale.
 * The browser's part is played here: it sends a session's cookie to its own origin. What the page's own code
 * put on each request is kept, as it was sent.
 */
function keel() {
  const clock = { now: Date.parse("2026-10-13T05:00:00Z") };
  const fake = createFakeKeel({
    agents: [AGENT],
    sessions: { ada: "stranger", grace: "stranger" },
    freshly: ["ada"],
    now: () => clock.now,
  });
  const fromThePage: Request[] = [];
  const as = (who?: "ada" | "grace") =>
    createHttpSponsorship({
      origin: ORIGIN,
      fetch: (input, init) => {
        const asked = new Request(input, init);
        fromThePage.push(asked.clone());
        const headers = new Headers(asked.headers);
        if (who !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${who}`);
        return fake.fetch(new Request(asked, { headers }));
      },
    });
  return { fake, clock, fromThePage, as };
}

const refusal = (error: unknown): unknown =>
  error instanceof KeelRefused ? { status: error.status, code: error.code } : error;

/** A refusal in full: Keel's sentence and the ways forward it gave under it, as a page shows them. */
const worded = (error: unknown): unknown =>
  error instanceof KeelRefused
    ? { status: error.status, code: error.code, said: error.message, next: error.next }
    : error;

describe("the link an agent hands the person it asks to stand behind it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("[sponsor.link] is read from the fragment, and one that is not whole is none", () => {
    expect(linkOf("#agent=agt_1&code=spn_2")).toEqual({ agentId: "agt_1", code: "spn_2" });
    expect(linkOf("#code=spn%2F2&agent=agt_1")).toEqual({ agentId: "agt_1", code: "spn/2" });
    for (const hash of [
      "",
      "#",
      "#agent=agt_1",
      "#code=spn_2",
      "#agent=&code=spn_2",
      "#agent=agt_1&code=",
    ])
      expect(linkOf(hash)).toBeNull();
  });

  it("[sponsor.fragment-gone] takes the fragment out of the address as it reads it, in the same history entry", () => {
    const replaced: unknown[][] = [];
    const history = {
      state: { kept: true },
      replaceState: (...asked: unknown[]) => void replaced.push(asked),
    };
    const at = { hash: "#agent=agt_1&code=spn_2", pathname: "/sponsor", search: "?theme=light" };
    expect(takeLink(at, history)).toEqual({ agentId: "agt_1", code: "spn_2" });
    // The entry is replaced, never pushed: no entry of the history holds the code, and the query stays.
    expect(replaced).toEqual([[{ kept: true }, "", "/sponsor?theme=light"]]);
    // A fragment that is not a whole link is taken out too: what it held may be half of one.
    replaced.length = 0;
    expect(takeLink({ ...at, hash: "#code=spn_2" }, history)).toBeNull();
    expect(replaced).toEqual([[{ kept: true }, "", "/sponsor?theme=light"]]);
    // With no fragment there is nothing to take out, and the address is left alone.
    replaced.length = 0;
    expect(takeLink({ ...at, hash: "" }, history)).toBeNull();
    expect(replaced).toEqual([]);
  });

  it("[sponsor.not-stored] puts what it read in no storage", () => {
    const written: string[] = [];
    const storage = {
      setItem: (key: string) => void written.push(key),
      getItem: () => null,
    };
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("localStorage", storage);
    const cookies: string[] = [];
    vi.stubGlobal("document", {
      set cookie(value: string) {
        cookies.push(value);
      },
    });
    takeLink(
      { hash: "#agent=agt_1&code=spn_2", pathname: "/sponsor", search: "" },
      { state: null, replaceState: () => undefined },
    );
    expect(written).toEqual([]);
    expect(cookies).toEqual([]);
  });

  it("[places.sponsor] has a page of its own, open to a visitor with no trip to sign in, and is no namespace", () => {
    expect(placeOf("/sponsor")).toEqual({ at: "sponsor" });
    expect(hrefOf({ at: "sponsor" })).toBe("/sponsor");
    expect(placeOf("/sponsor/more")).toBeNull();
    expect(parse("/sponsor", "")).toMatchObject({ namespace: null, project: null });
    // A visitor stays: the tap signs them in on the page, and a trip to sign in would lose what the link carried.
    const here = { pathname: "/sponsor", search: "" };
    expect(sentFrom({ at: "sponsor" }, { is: "visitor" }, here)).toBeNull();
    expect(sentFrom({ at: "sponsor" }, { is: "user", handle: "ada" }, here)).toBeNull();
    // Every other page of a signed-in user still sends a visitor to sign in.
    expect(
      sentFrom({ at: "settings" }, { is: "visitor" }, { pathname: "/settings", search: "" }),
    ).toBe("/login?next=%2Fsettings");
  });
});

describe("standing behind an agent", () => {
  it("[sponsor.card] reads who the agent is as anyone may, with no code and no credential, and an id Keel knows none by as none", async () => {
    const k = keel();
    expect(await k.as().findAgent(AGENT.id)).toEqual(AGENT);
    expect(await k.as().findAgent("agt_nobody")).toBeNull();
    expect(
      k.fake.calls.map((call) => `${call.method} ${call.path}${call.query} ${call.body}`),
    ).toEqual([`GET /v1/agents/${AGENT.id} `, "GET /v1/agents/agt_nobody "]);
  });

  it("[sponsor.code-in-body] sends the code in the body of the one call that approves, and in nothing else of it", async () => {
    const k = keel();
    const { code } = k.fake.askSponsor(AGENT.id);
    await k.as("ada").approve(AGENT.id, code);
    expect(k.fake.sponsorOf(AGENT.id)).toBe("ada");
    const [sent] = k.fromThePage;
    if (sent === undefined) throw new Error("nothing was sent");
    expect(k.fromThePage).toHaveLength(1);
    expect(`${sent.method} ${new URL(sent.url).pathname}`).toBe(
      `PUT /v1/agents/${AGENT.id}/sponsor`,
    );
    expect(await sent.clone().json()).toEqual({ code });
    // Not the address, the query or any header: the key is made of nothing the code could be read from.
    expect(sent.url).not.toContain(code);
    expect([...sent.headers].flat().join(" ")).not.toContain(code);
    expect(sent.headers.get("idempotency-key")).toMatch(/^console:sponsor:[0-9a-f-]{36}$/);
    // The page adds no credential of its own: the session is the browser's to send.
    expect(sent.headers.has("authorization") || sent.headers.has("cookie")).toBe(false);
  });

  it("[sponsor.refused] hands on Keel's refusals as Keel gives them: a stale sign-in, a code that is no good, an agent someone stands behind", async () => {
    const k = keel();
    const { code } = k.fake.askSponsor(AGENT.id);
    const tried = (
      who: "ada" | "grace" | undefined,
      agentId: string,
      with_: string,
      read = refusal,
    ) =>
      k
        .as(who)
        .approve(agentId, with_)
        .then(() => "approved", read);
    expect(await tried(undefined, AGENT.id, code)).toEqual({ status: 401, code: "auth.required" });
    // Grace's session was not signed in by a passkey in the last ten minutes: the right code changes nothing.
    expect(await tried("grace", AGENT.id, code, worded)).toEqual({
      status: 403,
      code: "auth.fresh_sign_in_required",
      said: "This needs a fresh sign-in: a passkey sign-in from the last ten minutes.",
      next: ["Sign in again with your passkey, then retry"],
    });
    expect(k.fake.sponsorOf(AGENT.id)).toBeUndefined();
    // A wrong code and an agent that is not there are one answer, with the one way forward Keel gives.
    const gone = { status: 404, code: "resource.not_found" };
    expect(await tried("ada", AGENT.id, "spn_wrong", worded)).toEqual({
      ...gone,
      said: "No agent is asking for a sponsor with that code: it is mistyped, already used or has run out. Ask the agent for a new link, and approve with that one.",
      next: ["Ask the agent for a new link, and approve with it"],
    });
    expect(await tried("ada", "agt_nobody", code)).toEqual(gone);
    // A code that has run out is that answer too.
    k.clock.now += SPONSOR_CODE_FOR_MS + 1;
    expect(await tried("ada", AGENT.id, code)).toEqual(gone);
    // A new request replaces the last, and is good once.
    const again = k.fake.askSponsor(AGENT.id);
    expect(await tried("ada", AGENT.id, code)).toEqual(gone);
    expect(await tried("ada", AGENT.id, again.code)).toBe("approved");
    // The approval spent the request: the same code again is the one answer of a code that is no good, and
    // says nothing of the agent now having a sponsor.
    expect(await tried("ada", AGENT.id, again.code)).toEqual(gone);
    expect(await tried("ada", AGENT.id, "spn_wrong")).toEqual(gone);
    // Keel gives an agent somebody stands behind no new code: it is the agent that is told it has a sponsor.
    // So no approval is ever told so, the sponsor's own second one included, and nobody is told to end a link.
    expect(() => k.fake.askSponsor(AGENT.id)).toThrow(SPONSOR_HELD);
    expect(await tried("ada", AGENT.id, again.code, worded)).toEqual({
      ...gone,
      said: "No agent is asking for a sponsor with that code: it is mistyped, already used or has run out. Ask the agent for a new link, and approve with that one.",
      next: ["Ask the agent for a new link, and approve with it"],
    });
    expect(k.fake.sponsorOf(AGENT.id)).toBe("ada");
  });

  it("[sponsor.touch-first] sends the approval only after the passkey touch, as whoever touched", async () => {
    const order: string[] = [];
    const sponsoring = (signedIn: Who | Error) => ({
      signIn: () => {
        order.push("touch");
        return signedIn instanceof Error ? Promise.reject(signedIn) : Promise.resolve(signedIn);
      },
      approve: (agentId: string, code: string) => {
        order.push(`approve ${agentId} ${code}`);
        return Promise.resolve();
      },
    });
    const link = { agentId: "agt_1", code: "spn_2" };
    // A visitor: the touch signs them in, and the approval goes as them.
    expect(await standBehind(sponsoring(ADA), link, null)).toEqual({ is: "approved", as: ADA });
    expect(order).toEqual(["touch", "approve agt_1 spn_2"]);
    // A touch the person called off sends nothing.
    order.length = 0;
    await expect(standBehind(sponsoring(new Error("called off")), link, ADA)).rejects.toThrow(
      "called off",
    );
    expect(order).toEqual(["touch"]);
  });

  it("[sponsor.other-account] sends nothing where the passkey is another account's than the one that was reading", async () => {
    const approved: string[] = [];
    const sponsoring = {
      signIn: () => Promise.resolve(GRACE),
      approve: (agentId: string) => {
        approved.push(agentId);
        return Promise.resolve();
      },
    };
    const link = { agentId: "agt_1", code: "spn_2" };
    expect(await standBehind(sponsoring, link, ADA)).toEqual({ is: "changed", to: GRACE });
    expect(approved).toEqual([]);
    // Read again as that account, the same tap is theirs.
    expect(await standBehind(sponsoring, link, GRACE)).toEqual({ is: "approved", as: GRACE });
    expect(approved).toEqual(["agt_1"]);
  });

  it("[sponsor.spent] ends the link on Keel's answer that the code or the agent is no good, and on no other", () => {
    expect(spent(new KeelRefused("gone", "resource.not_found", 404))).toBe(true);
    expect(spent(new KeelRefused("held", "agent.state_refused", 409))).toBe(true);
    // Another touch answers a stale sign-in; a touch called off and a Keel that did not answer are tried again.
    expect(spent(new KeelRefused("stale", "auth.fresh_sign_in_required", 403))).toBe(false);
    expect(spent(new KeelRefused("who", "auth.required", 401))).toBe(false);
    expect(spent(new KeelRefused("down", "", 503))).toBe(false);
    expect(spent(new Error("The passkey was not used"))).toBe(false);
  });
});
