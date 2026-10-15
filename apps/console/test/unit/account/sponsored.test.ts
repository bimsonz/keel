import { describe, expect, it } from "vitest";
import {
  PAUSED_BY_SPONSOR,
  afterMove,
  asksWhy,
  controlsOf,
  lineOf,
  reasonOf,
  standingOf,
} from "../../../src/account/sponsored.ts";
import type { AgentCard, AgentProfile } from "../../../src/contract/keel/index.ts";
import { createHttpSponsorship } from "../../../src/source/http.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import { SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";

const ORIGIN = "https://keel.example";
const BETA: AgentCard = { id: "agt_0000000000000000000000BETA", name: "beta", kind: "hosted" };
const GAMMA: AgentCard = {
  id: "agt_000000000000000000000GAMMA",
  name: "gamma",
  kind: "interactive",
};

/**
 * A Keel that knows two agents and three people's sessions: Ada's and Hedy's signed in by a passkey just now,
 * Grace's stale. Ada sponsors both agents, as she came to by approving each one's code. The browser's
 * part is played here: it sends a session's cookie to its own origin, and what the page's own code put on each
 * request is kept as it was sent.
 */
async function keel() {
  const fake = createFakeKeel({
    agents: [BETA, GAMMA],
    sessions: { ada: "stranger", grace: "stranger", hedy: "stranger" },
    freshly: ["ada", "hedy"],
  });
  const fromThePage: Request[] = [];
  const as = (who?: "ada" | "grace" | "hedy") =>
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
  for (const agent of [BETA, GAMMA])
    // oxlint-disable-next-line no-await-in-loop -- two approvals, one after the other
    await as("ada").approve(agent.id, fake.askSponsor(agent.id).code);
  fromThePage.length = 0;
  return { fake, fromThePage, as };
}

/** A refusal in full: Keel's sentence and the ways forward it gave under it, as a page shows them. */
const worded = (error: unknown): unknown =>
  error instanceof KeelRefused
    ? { status: error.status, code: error.code, said: error.message, next: error.next }
    : error;

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: BETA.id,
  projectId: "prj_1",
  name: "beta",
  kind: "hosted",
  scopes: [],
  sponsor: "ada",
  revocationEpoch: 0,
  state: "active",
  createdAt: "2026-10-13T05:00:00.000Z",
  ...over,
});

describe("the agents a person sponsors", () => {
  it("[sponsored.list] are the ones Keel lists to that person, and nobody is listed another's", async () => {
    const k = await keel();
    const listed = await k.as("ada").listSponsored();
    expect(
      listed.map((agent) => `${agent.name} ${agent.kind} ${agent.state} ${agent.sponsor}`),
    ).toEqual(["beta hosted active ada", "gamma interactive active ada"]);
    const [asked] = k.fromThePage;
    expect(`${asked?.method} ${asked?.url}`).toBe(`GET ${ORIGIN}/v1/agents/sponsored`);
    // Someone who sponsors none is listed none, and a visitor is asked to sign in.
    expect(await k.as("hedy").listSponsored()).toEqual([]);
    expect(await k.as(undefined).listSponsored().catch(worded)).toMatchObject({
      status: 401,
      code: "auth.required",
    });
  });

  it("[sponsored.calls] asks Keel for each move by its own operation, with a key made for the one attempt and no credential of the page's", async () => {
    const k = await keel();
    const paused = await k.as("ada").pause(BETA.id, "It pushed to the wrong branch");
    expect(paused).toMatchObject({ id: BETA.id, state: "suspended", sponsor: "ada" });
    expect(k.fake.pausedFor(BETA.id)).toBe("It pushed to the wrong branch");
    const unpaused = await k.as("ada").unpause(BETA.id);
    expect(unpaused).toMatchObject({ id: BETA.id, state: "active", sponsor: "ada" });
    const ended = await k.as("ada").end(BETA.id);
    expect(ended.sponsor).toBeUndefined();
    expect(k.fake.sponsorOf(BETA.id)).toBeUndefined();

    const sent = await Promise.all(
      k.fromThePage.map(async (request) => ({
        line: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.text(),
        key: request.headers.get("idempotency-key") ?? "",
      })),
    );
    expect(sent.map((request) => `${request.line} ${request.body}`)).toEqual([
      `POST /v1/agents/${BETA.id}/suspend {"reason":"It pushed to the wrong branch"}`,
      `POST /v1/agents/${BETA.id}/reinstate `,
      `DELETE /v1/agents/${BETA.id}/sponsor `,
    ]);
    expect(sent.map((request) => request.key.replace(/[0-9a-f-]{36}$/, "<uuid>"))).toEqual([
      "console:pause:<uuid>",
      "console:unpause:<uuid>",
      "console:end:<uuid>",
    ]);
    expect(new Set(sent.map((request) => request.key)).size).toBe(3);
    // The session is the browser's to send: the page adds no credential of its own.
    expect(
      k.fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);
  });

  it("[sponsored.refused] hands on Keel's refusals as Keel gives them, in its order: not the sponsor's, a stale sign-in, a move the agent's standing does not allow", async () => {
    const k = await keel();
    const tried = (
      who: "ada" | "grace" | "hedy" | undefined,
      move: "pause" | "unpause" | "end",
    ) => {
      const keelAs = k.as(who);
      const asked =
        move === "pause"
          ? keelAs.pause(BETA.id, "why")
          : move === "unpause"
            ? keelAs.unpause(BETA.id)
            : keelAs.end(BETA.id);
      return asked.then(() => "done", worded);
    };
    // To anyone but its sponsor the agent is not there, whatever they ask and however fresh their sign-in.
    for (const move of ["pause", "unpause", "end"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another, each read on its own
      expect(await tried("hedy", move)).toMatchObject({ status: 404, code: "resource.not_found" });
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await tried("grace", move)).toMatchObject({ status: 404, code: "resource.not_found" });
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await tried(undefined, move)).toMatchObject({ status: 401, code: "auth.required" });
    }
    expect(k.fake.standingOf(BETA.id)).toBe("active");
    expect(k.fake.sponsorOf(BETA.id)).toBe("ada");
    // The agent, as it stands, allows only some moves: Keel says which it refused, and why.
    expect(await tried("ada", "unpause")).toEqual({
      status: 409,
      code: "agent.state_refused",
      said: `${BETA.id} is active, where Reinstate is not allowed.`,
      next: [],
    });
    expect(await tried("ada", "pause")).toBe("done");
    expect(await tried("ada", "pause")).toEqual({
      status: 409,
      code: "agent.state_refused",
      said: `${BETA.id} is suspended, where Suspend is not allowed.`,
      next: ["Reinstate the agent first"],
    });
    // Ending the link is allowed of a paused agent, and Keel reinstates it as the link ends.
    expect(await tried("ada", "end")).toBe("done");
    expect(k.fake.standingOf(BETA.id)).toBe("active");
    expect(k.fake.sponsorOf(BETA.id)).toBeUndefined();
  });

  it("[sponsored.stale] is refused each move from a sign-in that is not fresh, in Keel's sentence with its way forward, and nothing is changed", async () => {
    // One person, whose passkey sign-in is new and then is not.
    const fresh = { value: true };
    const fake = createFakeKeel({
      agents: [BETA],
      readerOf: () => ({ id: "ada", fresh: fresh.value }),
    });
    const ada = createHttpSponsorship({
      origin: ORIGIN,
      fetch: (input, init) => fake.fetch(new Request(input, init)),
    });
    await ada.approve(BETA.id, fake.askSponsor(BETA.id).code);
    expect(fake.sponsorOf(BETA.id)).toBe("ada");
    // The same person, more than ten minutes after their passkey sign-in.
    fresh.value = false;
    for (const move of [
      () => ada.pause(BETA.id, "why"),
      () => ada.unpause(BETA.id),
      () => ada.end(BETA.id),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another, each read on its own
      expect(await move().then(() => "done", worded)).toEqual({
        status: 403,
        code: "auth.fresh_sign_in_required",
        said: "This needs a fresh sign-in: a passkey sign-in from the last ten minutes.",
        next: ["Sign in again with your passkey, then retry"],
      });
    }
    expect(fake.standingOf(BETA.id)).toBe("active");
    expect(fake.sponsorOf(BETA.id)).toBe("ada");
    // What a sponsor reads is held to no fresh sign-in.
    expect((await ada.listSponsored()).map((agent) => agent.name)).toEqual(["beta"]);
  });

  it("[sponsored.line] says what an agent declared itself as only where it declared a kind, beside its standing", () => {
    expect(lineOf({ kind: "hosted", state: "active" })).toBe("declared as hosted · Active");
    expect(lineOf({ state: "suspended" })).toBe("Paused");
  });

  it("[sponsored.controls] offers a sponsor the moves an agent's standing allows: pause an active one, unpause a paused one, and end either", () => {
    expect(controlsOf("active")).toEqual(["pause", "end"]);
    expect(controlsOf("suspended")).toEqual(["unpause", "end"]);
    // An agent Keel has revoked, or whose standing it did not say, is neither paused nor unpaused.
    expect(controlsOf("revoked")).toEqual(["end"]);
    expect(controlsOf(undefined)).toEqual(["end"]);
    const states: AgentProfile["state"][] = ["active", "suspended", "revoked", undefined];
    expect(states.map((state) => standingOf(state))).toEqual(["Active", "Paused", "Revoked", ""]);
  });

  it("[sponsored.pause-asks] confirms a pause first, in a dialog that asks why, and unpauses or ends the link at once", () => {
    expect(asksWhy("pause")).toBe(true);
    expect(asksWhy("unpause")).toBe(false);
    expect(asksWhy("end")).toBe(false);
  });

  it("[sponsored.reason] sends the reason the sponsor typed, and one sentence of its own where they typed none: Keel keeps a reason with every pause", () => {
    expect(reasonOf("  It pushed to the wrong branch ")).toBe("It pushed to the wrong branch");
    expect(reasonOf("")).toBe(PAUSED_BY_SPONSOR);
    expect(reasonOf("   ")).toBe(PAUSED_BY_SPONSOR);
    expect(PAUSED_BY_SPONSOR).toBe("Paused by its sponsor");
  });

  it("[sponsored.after] says of an agent what Keel answered, and lists no agent Keel no longer names the reader the sponsor of", () => {
    const listed = [profile(), profile({ id: GAMMA.id, name: "gamma" })];
    // A pause: the row is Keel's answer, and the other row is as it was.
    const paused = afterMove(listed, profile({ state: "suspended" }), "ada");
    expect(paused.map((agent) => `${agent.name} ${agent.state}`)).toEqual([
      "beta suspended",
      "gamma active",
    ]);
    // The link ended: Keel's answer names no sponsor, and the row is gone.
    const { sponsor: _gone, ...unsponsored } = profile();
    expect(afterMove(listed, unsponsored, "ada").map((agent) => agent.name)).toEqual(["gamma"]);
    // An agent that has come to be another person's is not this reader's to list.
    expect(
      afterMove(listed, profile({ sponsor: "grace" }), "ada").map((agent) => agent.name),
    ).toEqual(["gamma"]);
    // An answer about an agent that is not listed adds no row.
    expect(afterMove(listed, profile({ id: "agt_other" }), "ada")).toEqual(listed);
  });
});
