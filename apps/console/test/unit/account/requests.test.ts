import { describe, expect, it } from "vitest";
import type { Who } from "../../../src/account/account.ts";
import { approveRequest } from "../../../src/account/sponsoring.ts";
import type { AgentCard, NamespaceView, ProjectView } from "../../../src/contract/keel/index.ts";
import { agentNames } from "../../../src/engine/owners.ts";
import { createHttpSponsorRequests } from "../../../src/source/sponsorRequests.ts";
import { KeelRefused } from "../../../src/source/types.ts";
import { SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";

const ORIGIN = "https://keel.example";
const AGENT: AgentCard = {
  id: "agt_0000000000000000000000BETA",
  name: "beta",
  handle: "agent-0000000000beta",
  kind: "hosted",
};
const OTHER: AgentCard = { id: "agt_000000000000000000000OTHER", name: "other", kind: "hosted" };
const ADA: Who = { id: "ada", name: "Ada", handle: "ada" };
const GRACE: Who = { id: "grace", name: "Grace", handle: "grace" };

/**
 * A Keel that knows one agent and two people's sessions: Ada's signed in by a passkey just now, Grace's stale.
 * The browser's part is played here: it sends a session's cookie to its own origin.
 */
function keel() {
  const fake = createFakeKeel({
    agents: [AGENT, OTHER],
    sessions: { ada: "stranger", grace: "stranger" },
    freshly: ["ada"],
  });
  const as = (who: "ada" | "grace") =>
    createHttpSponsorRequests({
      origin: ORIGIN,
      fetch: (input, init) => {
        const asked = new Request(input, init);
        const headers = new Headers(asked.headers);
        headers.set("cookie", `${SESSION_COOKIE}=${who}`);
        return fake.fetch(new Request(asked, { headers }));
      },
    });
  return { fake, as };
}

const refusal = (error: unknown): unknown =>
  error instanceof KeelRefused ? { status: error.status, code: error.code } : error;

describe("the agents asking a person to sponsor them", () => {
  it("[requests.http] lists them, approves one from a fresh sign-in only, and declines one with or without a block", async () => {
    const { fake, as } = keel();
    fake.asksPerson(AGENT.id, "ada");
    fake.asksPerson(AGENT.id, "grace");
    fake.asksPerson(OTHER.id, "grace");

    // Each person is listed their own request, with the agent's card.
    const listed = await as("ada").list();
    expect(listed.map((one) => one.agent)).toEqual([AGENT]);
    expect(Date.parse(listed[0]?.expiresAt ?? "")).toBeGreaterThan(
      Date.parse(listed[0]?.askedAt ?? ""),
    );

    // Grace's sign-in is stale: Keel wants a fresh one before it looks for the request.
    expect(await as("grace").approve(AGENT.id, "console:sponsor-request:1").catch(refusal)).toEqual(
      { status: 403, code: "auth.fresh_sign_in_required" },
    );
    expect(fake.sponsorOf(AGENT.id)).toBeUndefined();

    // Ada's is fresh: she sponsors it, and her request is gone from her list.
    await as("ada").approve(AGENT.id, "console:sponsor-request:2");
    expect(fake.sponsorOf(AGENT.id)).toBe("ada");
    expect(await as("ada").list()).toEqual([]);
    expect(await as("ada").approve(AGENT.id, "console:sponsor-request:3").catch(refusal)).toEqual({
      status: 404,
      code: "resource.not_found",
    });

    // A decline wants no fresh sign-in. With a block, the agent may not ask again.
    expect((await as("grace").list()).map((one) => one.agent.id)).toContain(OTHER.id);
    await as("grace").decline(OTHER.id, true, "console:sponsor-request:4");
    expect((await as("grace").list()).map((one) => one.agent.id)).not.toContain(OTHER.id);
    expect(() => fake.asksPerson(OTHER.id, "grace")).toThrow("is blocked by grace");

    const moves = fake.calls.filter((call) => call.path.startsWith("/v1/users/me/"));
    expect(moves.map((call) => [call.method, call.path, call.query])).toEqual([
      ["GET", "/v1/users/me/sponsor-requests", ""],
      ["PUT", `/v1/users/me/sponsor-requests/${AGENT.id}`, ""],
      ["PUT", `/v1/users/me/sponsor-requests/${AGENT.id}`, ""],
      ["GET", "/v1/users/me/sponsor-requests", ""],
      ["PUT", `/v1/users/me/sponsor-requests/${AGENT.id}`, ""],
      ["GET", "/v1/users/me/sponsor-requests", ""],
      ["DELETE", `/v1/users/me/sponsor-requests/${OTHER.id}`, "block=true"],
      ["GET", "/v1/users/me/sponsor-requests", ""],
    ]);
    // Every move carries its attempt's own key.
    expect(
      moves.filter((call) => call.method !== "GET").map((call) => call.idempotencyKey),
    ).toEqual([1, 2, 3, 4].map((n) => `console:sponsor-request:${n}`));
  });

  it("[requests.decline] declines without a block, and the agent may ask again", async () => {
    const { fake, as } = keel();
    fake.asksPerson(AGENT.id, "ada");
    await as("ada").decline(AGENT.id, false, "console:sponsor-request:5");
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", query: "" });
    expect(await as("ada").list()).toEqual([]);
    fake.asksPerson(AGENT.id, "ada");
    expect((await as("ada").list()).map((one) => one.agent.id)).toEqual([AGENT.id]);
  });

  it("[requests.approve-touch] touches a passkey first, and sends nothing where it is another account's", async () => {
    const happened: string[] = [];
    const answering = (who: Who) => ({
      signIn: async () => {
        happened.push(`touch:${who.id}`);
        return who;
      },
      approve: async (agentId: string, key: string) => {
        happened.push(`approve:${agentId}:${key}`);
      },
    });
    expect(await approveRequest(answering(ADA), AGENT.id, "ada", "k1")).toEqual({
      is: "approved",
      as: ADA,
    });
    expect(await approveRequest(answering(GRACE), AGENT.id, "ada", "k2")).toEqual({
      is: "changed",
      to: GRACE,
    });
    expect(happened).toEqual(["touch:ada", `approve:${AGENT.id}:k1`, "touch:grace"]);
  });
});

/** A project as Keel lists one, by its owner's handle and kind: the rest of it is no matter here. */
const project = (handle: string, kind: ProjectView["namespace"]["kind"], name: string) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a list entry's other fields are not read
  ({
    id: `prj_${handle}_${name}`,
    name,
    namespace: { handle, kind },
    visibility: "public",
  }) as ProjectView;

describe("the name a project's owner is shown by", () => {
  const namespaces: Record<string, NamespaceView> = {
    "agent-0000000000beta": { id: AGENT.id, handle: "agent-0000000000beta", kind: "agent" },
    "agent-00000000gamma": { id: "agt_GAMMA", handle: "agent-00000000gamma", kind: "agent" },
    "agent-000000000same": { id: "agt_SAME", handle: "agent-000000000same", kind: "agent" },
  };
  const cards: Record<string, AgentCard> = {
    [AGENT.id]: AGENT,
    agt_SAME: { id: "agt_SAME", name: "agent-000000000same" },
  };

  it("[owner.name] reads an agent's namespace by its card's name, and a person's and an org's by handle", async () => {
    const asked: string[] = [];
    const names = await agentNames(
      [
        project("agent-0000000000beta", "agent", "one"),
        project("agent-0000000000beta", "agent", "two"),
        project("agent-00000000gamma", "agent", "three"),
        project("agent-000000000same", "agent", "four"),
        project("ada", "user", "five"),
        project("acme", "org", "six"),
      ],
      {
        findNamespace: async (handle) => {
          asked.push(handle);
          return namespaces[handle] ?? null;
        },
      },
      {
        findAgent: async (agentId) => {
          // Keel could not be read for gamma's card: it is shown by its handle.
          if (agentId === "agt_GAMMA") throw new Error("Keel did not answer");
          return cards[agentId] ?? null;
        },
      },
    );
    expect([...names]).toEqual([["agent-0000000000beta", "beta"]]);
    // Each agent's namespace is asked once, and nobody else's.
    expect(asked).toEqual(["agent-0000000000beta", "agent-00000000gamma", "agent-000000000same"]);
  });
});
