import { describe, expect, it } from "vitest";
import { SCOPES } from "../../../src/account/orgAgents.ts";
import type { AgentCard, NamespaceRef, Scope } from "../../../src/contract/keel/index.ts";
import {
  createHttpOrgAgents,
  createHttpSource,
  createHttpSponsorship,
} from "../../../src/source/http.ts";
import { invitesHere } from "../../../src/pages/ProjectAgents.tsx";
import { KeelRefused } from "../../../src/source/types.ts";
import { SESSION_COOKIE, createFakeKeel } from "../../fixtures/mock/fakeKeel.ts";

const ORIGIN = "https://keel.example";
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

type Person = "ada" | "eve";

/**
 * A Keel whose project is in a person's own namespace, Ada's, unless a test says whose: Ada is its owner and
 * Eve is nobody to it. The browser's part is played here: it sends a session's cookie and the page's origin,
 * and what the page's own code put on each request is kept as it was sent.
 */
function keel(
  over: {
    namespace?: NamespaceRef;
    visibility?: "private" | "public";
    freshly?: readonly Person[];
  } = {},
) {
  const fake = createFakeKeel({
    namespace: over.namespace ?? { handle: "ada", kind: "user" },
    visibility: over.visibility ?? "public",
    agents: [OTTER, HERON, BETA],
    sessions: { ada: "owner", eve: "stranger" },
    freshly: over.freshly ?? ["ada", "eve"],
    now: () => Date.parse("2026-10-13T21:00:00.000Z"),
  });
  const fromThePage: Request[] = [];
  const serve = (who?: Person) => (asked: Request) => {
    const headers = new Headers(asked.headers);
    if (who !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${who}`);
    headers.set("origin", ORIGIN);
    return fake.fetch(new Request(asked, { headers }));
  };
  const options = (who?: Person) => ({
    origin: ORIGIN,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const asked = new Request(input, init);
      fromThePage.push(asked.clone());
      return serve(who)(asked);
    },
  });
  const as = (who?: Person) => createHttpSource(fake.project, options(who)).invited;
  /** A move sent with a key of the test's choosing. */
  const keyed = async (who: Person, key: string, agent: string, scopes: readonly Scope[]) => {
    const response = await serve(who)(
      new Request(`${ORIGIN}/v1/projects/${fake.project.id}/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ agent, scopes }),
      }),
    );
    const body: { code?: string; state?: string } = await response.json();
    return `${response.status} ${body.code ?? body.state ?? ""}`;
  };
  return { fake, fromThePage, as, keyed, options };
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
const NOT_THE_OWNER = {
  status: 403,
  code: "auth.forbidden",
  said: "Refused: role.",
  next: [
    "This is a person's own namespace and has no members: only its owner does this. Use your own namespace, or an org you are a member of",
  ],
};

describe("the agents invited to one project", () => {
  it("[project-agents.read] are read to the project's owner with the invitations not yet answered and what each gives, and to anyone else who reads the project as the ones that joined", async () => {
    const k = keel();
    await k.as("ada").inviteAgent("tidy-otter", SCOPES.read);
    await k.as("ada").inviteAgent("quiet-heron", SCOPES.work);
    k.fake.joins(k.fake.project.id, HERON.id);
    expect(await k.as("ada").listAgents()).toEqual([
      {
        id: OTTER.id,
        name: "Tidy Otter",
        handle: "tidy-otter",
        state: "invited",
        scopes: ["agent:read"],
        invitedBy: "ada",
        invitedAt: "2026-10-13T21:00:00.000Z",
      },
      {
        id: HERON.id,
        name: "Quiet Heron",
        handle: "quiet-heron",
        state: "joined",
        scopes: ["agent:read", "agent:work"],
        invitedBy: "ada",
        invitedAt: "2026-10-13T21:00:00.000Z",
        joinedAt: "2026-10-13T21:00:00.000Z",
      },
    ]);
    const joined = [
      {
        id: HERON.id,
        name: "Quiet Heron",
        handle: "quiet-heron",
        state: "joined",
        joinedAt: "2026-10-13T21:00:00.000Z",
      },
    ];
    expect(await k.as("eve").listAgents()).toEqual(joined);
    expect(await k.as(undefined).listAgents()).toEqual(joined);
  });

  it("[project-agents.unseen] are read to nobody a private project is not read to, and an org's project has none of its own", async () => {
    const shut = keel({ visibility: "private" });
    await shut.as("ada").inviteAgent("tidy-otter", SCOPES.work);
    shut.fake.joins(shut.fake.project.id, OTTER.id);
    expect(await shut.as("ada").listAgents()).toHaveLength(1);
    expect(await shut.as("eve").listAgents().catch(worded)).toMatchObject(NOT_THERE);
    expect(await shut.as(undefined).listAgents().catch(worded)).toMatchObject(NOT_THERE);
    // An org takes an agent into the whole of it: its project lists none, and takes none, from its owner either.
    const orgs = keel({ namespace: { handle: "acme", kind: "org" } });
    expect(await orgs.as("ada").listAgents()).toEqual([]);
    expect(await orgs.as("ada").inviteAgent("tidy-otter", SCOPES.work).catch(worded)).toMatchObject(
      NOT_THERE,
    );
    expect(await orgs.as("ada").removeAgent(OTTER.id).catch(worded)).toMatchObject(NOT_THERE);
  });

  it("[project-agents.calls] asks Keel for an invitation and a removal by its own operations on the project, with the scopes chosen, a key made for the one attempt and no credential of the page's", async () => {
    const k = keel();
    const id = k.fake.project.id;
    await k.as("ada").inviteAgent("tidy-otter", SCOPES.read);
    await k.as("ada").inviteAgent("quiet-heron", SCOPES.work);
    const ended = await k.as("ada").removeAgent(OTTER.id);
    expect(ended).toMatchObject({ id: OTTER.id, state: "ended" });
    await k.as("ada").listAgents();
    const sent = await Promise.all(
      k.fromThePage.map(async (request) => ({
        line: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.text(),
        key: request.headers.get("idempotency-key") ?? "",
      })),
    );
    expect(sent.map((request) => `${request.line} ${request.body}`)).toEqual([
      `POST /v1/projects/${id}/agents {"agent":"tidy-otter","scopes":["agent:read"]}`,
      `POST /v1/projects/${id}/agents {"agent":"quiet-heron","scopes":["agent:read","agent:work"]}`,
      `DELETE /v1/projects/${id}/agents/${OTTER.id} `,
      `GET /v1/projects/${id}/agents `,
    ]);
    expect(sent.map((request) => request.key.replace(/[0-9a-f-]{36}$/, "<uuid>"))).toEqual([
      "console:invite-agent:<uuid>",
      "console:invite-agent:<uuid>",
      "console:remove-agent:<uuid>",
      "",
    ]);
    expect(new Set(sent.map((request) => request.key)).size).toBe(4);
    expect(
      k.fromThePage.filter(
        (request) => request.headers.has("authorization") || request.headers.has("cookie"),
      ),
    ).toEqual([]);
  });

  it("[project-agents.refused] hands on Keel's refusals of an invitation as Keel gives them, in its order: no session, a handle that is none, not the project's owner, a stale sign-in, scopes it does not give, no such agent, an invitation that stands on other terms", async () => {
    const k = keel();
    const tried = (who: Person | undefined, agent: string, scopes: readonly Scope[]) =>
      k
        .as(who)
        .inviteAgent(agent, scopes)
        .then(() => "invited", worded);
    expect(await tried(undefined, "tidy-otter", SCOPES.work)).toMatchObject({
      status: 401,
      code: "auth.required",
    });
    expect(await tried("eve", "Tidy Otter", SCOPES.work)).toMatchObject({
      status: 400,
      code: "request.invalid",
    });
    // Someone the project is read to, who is not its owner: told so before the scopes or the agent are looked at.
    expect(await tried("eve", "nobody-at-all", ["agent:work"])).toEqual(NOT_THE_OWNER);
    // The owner, on a sign-in that is not fresh, whatever else is wrong with what they asked.
    const stale = keel({ freshly: [] });
    expect(
      await stale.as("ada").inviteAgent("nobody-at-all", ["agent:work"]).catch(worded),
    ).toEqual(STALE);
    expect(await stale.as("ada").removeAgent(OTTER.id).catch(worded)).toEqual(STALE);
    const SCOPES_REFUSED = {
      status: 400,
      code: "request.invalid",
      said: "An invitation gives agent:read, or agent:read and agent:work, each named once.",
      next: [],
    };
    expect(await tried("ada", "nobody-at-all", ["agent:work"])).toEqual(SCOPES_REFUSED);
    for (const handle of ["nobody-at-all", "ada", "beta"])
      // oxlint-disable-next-line no-await-in-loop -- three asks, one after the other
      expect(await tried("ada", handle, SCOPES.work)).toEqual({
        ...NOT_THERE,
        said: `No agent has the handle ${handle}.`,
      });
    expect(await k.as("ada").listAgents()).toEqual([]);

    // An invitation that stands is changed by taking the agent off first. The same terms again change nothing.
    expect(await tried("ada", "tidy-otter", SCOPES.read)).toBe("invited");
    expect(await tried("ada", "tidy-otter", SCOPES.work)).toEqual({
      status: 409,
      code: "invitation.state_refused",
      said: `${OTTER.id} already has an invitation to this project. Take it off first to invite it again or to change what it may do.`,
      next: ["Read the agents invited to the project"],
    });
    k.fake.joins(k.fake.project.id, OTTER.id);
    expect(await k.as("ada").inviteAgent("tidy-otter", SCOPES.read)).toMatchObject({
      state: "joined",
      scopes: ["agent:read"],
    });
    expect(await k.as("ada").listAgents()).toHaveLength(1);
  });

  it("[project-agents.remove] takes a removal from the project's owner alone, and tells its owner an agent with no place on it is not there", async () => {
    const k = keel();
    await k.as("ada").inviteAgent("tidy-otter", SCOPES.work);
    await k.as("ada").inviteAgent("quiet-heron", SCOPES.read);
    const tried = (who: Person | undefined, agentId: string) =>
      k
        .as(who)
        .removeAgent(agentId)
        .then((answered) => answered.state, worded);
    expect(await tried(undefined, OTTER.id)).toMatchObject({ status: 401, code: "auth.required" });
    expect(await tried("eve", OTTER.id)).toEqual(NOT_THE_OWNER);
    expect(await k.as("ada").listAgents()).toHaveLength(2);
    expect(await tried("ada", OTTER.id)).toBe("ended");
    expect(await tried("ada", OTTER.id)).toMatchObject(NOT_THERE);
    expect(await tried("ada", BETA.id)).toMatchObject(NOT_THERE);
    // An ended row is in no list, and the agent may be invited again: last.
    await k.as("ada").inviteAgent("tidy-otter", SCOPES.read);
    expect((await k.as("ada").listAgents()).map((agent) => agent.handle)).toEqual([
      "quiet-heron",
      "tidy-otter",
    ]);
  });

  it("[project-agents.key] answers the same invitation asked again under its key as it was, and refuses the key on another, a key that is none, and another site's page", async () => {
    const k = keel();
    expect(await k.keyed("ada", "key-one-of-ada", "tidy-otter", SCOPES.read)).toBe("201 invited");
    expect(await k.keyed("ada", "key-one-of-ada", "tidy-otter", SCOPES.read)).toBe("201 invited");
    expect(await k.keyed("ada", "key-one-of-ada", "tidy-otter", SCOPES.work)).toBe(
      "409 request.idempotency_conflict",
    );
    expect(await k.keyed("ada", "short", "quiet-heron", SCOPES.read)).toBe("400 request.invalid");
    const crossed = await k.fake.fetch(
      new Request(`${ORIGIN}/v1/projects/${k.fake.project.id}/agents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "key-two-of-ada",
          cookie: `${SESSION_COOKIE}=ada`,
          origin: "https://elsewhere.example",
        },
        body: JSON.stringify({ agent: "quiet-heron" }),
      }),
    );
    expect(crossed.status).toBe(403);
    expect(await k.as("ada").listAgents()).toHaveLength(1);
  });

  it("[project-agents.offered] offers the form on a project of a person's own namespace to its owner, and on no other project and to nobody else", () => {
    const k = keel();
    const mine = { ...k.fake.project, viewer: { role: "owner" as const } };
    expect(invitesHere(mine)).toBe(true);
    // The same project as anyone else is read it, and an org's, to its owner too.
    expect(invitesHere(k.fake.project)).toBe(false);
    expect(invitesHere({ ...mine, namespace: { handle: "acme", kind: "org" } })).toBe(false);
    expect(invitesHere({ ...mine, viewer: { role: "maintainer" } })).toBe(false);
  });

  it("[project-agents.apart] keeps an agent's place on a project apart from a place in an org: it is in no org's list, and its card names no project", async () => {
    const k = keel();
    await k.as("ada").inviteAgent("tidy-otter", SCOPES.work);
    k.fake.joins(k.fake.project.id, OTTER.id);
    expect(await createHttpOrgAgents(k.options("ada")).listAgents("ada")).toEqual([]);
    expect(await createHttpSponsorship(k.options(undefined)).findAgent(OTTER.id)).toEqual(OTTER);
  });
});
