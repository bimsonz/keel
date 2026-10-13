// An agent's invitation into an org through the deployed fetch handler: a
// person signed in by passkey invites an agent that signed itself up with a
// key, the agent accepts with its own token, and from then on a token that
// names one of the org's projects reads and works there. Every step goes
// token or session, gate, policy, handler, port, the namespace's own object,
// and the D1 row the gate reads on the next request.
import { env } from "cloudflare:workers";
import { namespaceAddress } from "@keeltown/core/application/coordination";
import { agentIdOf } from "@keeltown/core/domain/identity";
import {
  type AgentId,
  EventEnvelope,
  makeId,
  type NamespaceId,
  type ProjectId,
  type UserId,
} from "@keeltown/core/kernel";
import { Invitations, NamespaceAgents, PROJECTOR } from "@keeltown/core/ports";
import { describeInvitationsContract, describeNamespaceAgentsContract } from "@keeltown/testing";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { NamespaceAgentsD1 } from "../../src/adapters/driven/d1/namespace-agents.ts";
import { InvitationsRpc } from "../../src/adapters/driven/do-rpc/invitations.ts";
import { decodeExit, NamespaceCodecs } from "../../src/rpc/index.ts";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  placeProject,
  seedOrg,
  seedUser,
  uniqueHandle,
  worker,
} from "./helpers.ts";

const WAIT = { timeout: 15_000, interval: 25 };
const REGISTER = `${BASE}/v1/oauth/register`;

const namespaceStub = (address: string) =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(address)));
const agentStub = (agentId: AgentId) =>
  drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`)));

// The real adapters pass the same contract suites as the in-memory ones, inside workerd.
describeNamespaceAgentsContract("d1", () => NamespaceAgentsD1(env.DB));
describeInvitationsContract("the namespace's own object, and d1", () =>
  Layer.mergeAll(InvitationsRpc(namespaceStub), NamespaceAgentsD1(env.DB)),
);

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** One request through the real Worker, as `bearer` (nobody when null), with a JSON body when given. */
async function http(
  bearer: string | null,
  method: string,
  path: string,
  body?: object,
): Promise<Answer> {
  const headers = new Headers({ "cf-connecting-ip": freshAddress() });
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  if (method !== "GET") headers.set("idempotency-key", `key-${ulid()}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await worker(`${BASE}/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: Object(await response.json()) };
}

const refusal = (a: Answer) => [a.status, a.body["code"]];
const reason = (a: Answer) => [a.status, a.body["code"], a.body["detail"]];
const items = (a: Answer): readonly Record<string, unknown>[] => {
  const list = a.body["items"];
  return Array.isArray(list) ? list : [];
};

/** An org with its owner, a member signed in by passkey, and a private project placed in it. */
async function anOrg() {
  const org: NamespaceId = makeId("org", ulid());
  const slug = uniqueHandle("inv");
  const owner: UserId = makeId("usr", ulid());
  await seedOrg(org, slug, owner, uniqueHandle("owner"));
  const member = await seedUser(uniqueHandle("ann"), { org, signedInBy: "passkey" });
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId, org);
  await establishProject(projectId);
  namespaceStub(namespaceAddress(org));
  return { org, slug, member, projectId };
}

/** An agent that signed itself up through the Worker with a key and nothing else. */
async function keyAgent() {
  const account = await newKey();
  const registered = await worker(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": freshAddress(),
      dpop: await proofBy(account, "POST", REGISTER),
    },
    body: JSON.stringify({
      jwks: { keys: [account.publicJwk] },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
    }),
  });
  if (registered.status !== 201)
    throw new Error(`the sign-up answered ${registered.status}: ${await registered.text()}`);
  const agentId = agentIdOf(account.key.jkt);
  agentStub(agentId);
  const card = await http(null, "GET", `/agents/${agentId}`);
  const handle = String(card.body["handle"]);
  /** A token of the agent's: for one project, or for none (its own account). */
  const token = async (project?: ProjectId, scope?: string) =>
    (
      await granted(
        await requestToken(agentId, account, {
          ...(project === undefined ? {} : { project }),
          ...(scope === undefined ? {} : { scope }),
        }),
      )
    ).access_token;
  return { agentId, handle, token };
}

const rows = <A>(effect: Effect.Effect<A, never, NamespaceAgents>) =>
  Effect.runPromise(Effect.provide(effect, NamespaceAgentsD1(env.DB)));

describe("an agent's invitation into an org, through the real Worker", () => {
  it("[link.standing] invited it has nothing; accepted it reads and works in the org's project; its inviter gone it is refused at once; taken out it is a stranger again", async () => {
    const { org, slug, member, projectId } = await anOrg();
    const agent = await keyAgent();
    const own = await agent.token();
    const inOrg = await agent.token(projectId);
    const read = () => http(inOrg, "GET", `/changes?project=${projectId}`);
    const work = () => http(inOrg, "POST", "/sessions", { harness: "pool" });

    // Before anyone invites it the org's private project is not there for it.
    expect(refusal(await read())).toEqual([404, "resource.not_found"]);
    expect(items(await http(own, "GET", "/agents/me/namespaces"))).toEqual([]);

    // A session that is no fresh passkey sign-in is refused the touch; nothing is written.
    const coded = await seedUser(uniqueHandle("cody"), { org, signedInBy: "email-otp" });
    const untouched = await http(coded.token, "POST", `/namespaces/${slug}/agents`, {
      agent: agent.handle,
    });
    expect(refusal(untouched)).toEqual([403, "auth.fresh_sign_in_required"]);
    // Someone who is no member of the org invites no one into it.
    const outsider = await seedUser(uniqueHandle("otto"), { role: null, signedInBy: "passkey" });
    const foreign = await http(outsider.token, "POST", `/namespaces/${slug}/agents`, {
      agent: agent.handle,
    });
    expect(foreign.status).toBe(403);
    expect(await rows(NamespaceAgents.use((r) => r.find(agent.agentId, org)))).toEqual(
      Option.none(),
    );

    // The member invites it by its handle.
    const invited = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
      agent: agent.handle,
    });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({
      id: agent.agentId,
      handle: agent.handle,
      state: "invited",
      scopes: ["agent:read", "agent:work"],
      invitedBy: member.userId,
    });
    // No agent has that handle, and a person's handle names no agent.
    const unknown = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
      agent: "agent-nobodyatall0000",
    });
    expect(refusal(unknown)).toEqual([404, "resource.not_found"]);
    const aPerson = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
      agent: member.handle,
    });
    expect(refusal(aPerson)).toEqual([404, "resource.not_found"]);
    // More than read and work is never given.
    const tooMuch = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
      agent: agent.handle,
      scopes: ["agent:work"],
    });
    expect(refusal(tooMuch)).toEqual([400, "request.invalid"]);
    // One member answers for an agent: another member's invitation is refused while this one stands.
    const second = await seedUser(uniqueHandle("ben"), { org, signedInBy: "passkey" });
    const twice = await http(second.token, "POST", `/namespaces/${slug}/agents`, {
      agent: agent.handle,
    });
    expect(refusal(twice)).toEqual([409, "invitation.state_refused"]);

    // A pending invitation gives nothing.
    expect(refusal(await read())).toEqual([404, "resource.not_found"]);
    // The agent is told, with what it can do about it, and reads the invitation as its own.
    const notices = await vi.waitFor(async () => {
      const inbox = await http(inOrg, "GET", "/inbox");
      const result = Object(inbox.body["result"]);
      const found: Record<string, unknown>[] = Array.isArray(result["notices"])
        ? result["notices"]
        : [];
      expect(found.map((notice) => notice["kind"])).toEqual(["AgentInvited"]);
      return found;
    }, WAIT);
    const [told] = notices;
    expect(String(told?.["detail"])).toBe(
      `a member invited you into ${org}: accept, and a token that names one of its projects reads and works there`,
    );
    const next = Array.isArray(told?.["nextActions"]) ? told["nextActions"] : [];
    expect(
      next.map((action: Record<string, unknown>) => [action["operationId"], action["args"]]),
    ).toEqual([
      ["Agents_acceptInvitation", { namespace: org }],
      ["Agents_leaveNamespace", { namespace: org }],
    ]);
    const mine = await http(own, "GET", "/agents/me/namespaces");
    expect(items(mine)).toMatchObject([
      { namespace: { handle: slug, kind: "org" }, state: "invited" },
    ]);
    expect(JSON.stringify(mine.body)).not.toContain(member.userId);

    // A namespace that never invited it, and one that does not exist, read the same to it.
    const elsewhere = await anOrg();
    const uninvited = await http(own, "PUT", `/agents/me/namespaces/${elsewhere.slug}`);
    const missing = await http(own, "PUT", "/agents/me/namespaces/no-such-namespace");
    expect(refusal(uninvited)).toEqual([404, "resource.not_found"]);
    expect({ ...uninvited.body, requestId: null, instance: null }).toEqual({
      ...missing.body,
      requestId: null,
      instance: null,
    });

    // It accepts, by the id its notice named; the token it already held works on its next request.
    const accepted = await http(own, "PUT", `/agents/me/namespaces/${org}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      namespace: { handle: slug, kind: "org" },
      state: "joined",
    });
    expect((await read()).status).toBe(200);
    expect((await work()).status).toBe(201);

    // Anyone reads who has joined, by who it is; only a member reads who invited it.
    const publicList = await http(null, "GET", `/namespaces/${slug}/agents`);
    expect(items(publicList)).toEqual([
      expect.objectContaining({ id: agent.agentId, handle: agent.handle, state: "joined" }),
    ]);
    expect(JSON.stringify(publicList.body)).not.toContain(member.userId);
    expect(items(publicList)[0]).not.toHaveProperty("scopes");
    const membersList = await http(second.token, "GET", `/namespaces/${slug}/agents`);
    expect(items(membersList)).toMatchObject([
      { id: agent.agentId, state: "joined", invitedBy: member.userId },
    ]);

    // A member who did not invite it does not take it out.
    const notTheirs = await http(
      second.token,
      "DELETE",
      `/namespaces/${slug}/agents/${agent.agentId}`,
    );
    expect(notTheirs.status).toBe(403);
    expect((await read()).status).toBe(200);

    // The member who invited it leaves the org: the agent is refused at once, and nothing was written for it.
    await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?")
      .bind(org, member.userId)
      .run();
    expect(reason(await work())).toEqual([403, "auth.forbidden", "Refused: inviter-left."]);
    expect(await rows(NamespaceAgents.use((r) => r.find(agent.agentId, org)))).toMatchObject(
      Option.some({ state: "joined", by: member.userId }),
    );
    // Back in the org, the same invitation answers again.
    await env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)",
    )
      .bind(ulid(), org, member.userId, new Date().toISOString())
      .run();
    expect((await work()).status).toBe(201);

    // Another agent is invited into the same org: this one hears nothing of it, and nobody outside reads it.
    const other = await keyAgent();
    const beside = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
      agent: other.handle,
    });
    expect(beside.status).toBe(201);
    expect(items(await http(null, "GET", `/namespaces/${slug}/agents`))).toHaveLength(1);

    // Taking it out wants the touch too: the same member on a session that is no fresh sign-in is refused.
    const stale = crypto.randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, signedInBy) VALUES (?, ?, ?, ?, ?, ?, 'email-otp')",
    )
      .bind(ulid(), new Date(Date.now() + 3_600_000).toISOString(), stale, now, now, member.userId)
      .run();
    const untouchedEnd = await http(stale, "DELETE", `/namespaces/${slug}/agents/${agent.agentId}`);
    expect(refusal(untouchedEnd)).toEqual([403, "auth.fresh_sign_in_required"]);
    expect((await read()).status).toBe(200);

    // The member who invited it takes it out; from its next request it is a stranger there.
    const removed = await http(
      member.token,
      "DELETE",
      `/namespaces/${slug}/agents/${agent.agentId}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ id: agent.agentId, state: "ended" });
    expect(refusal(await read())).toEqual([404, "resource.not_found"]);
    expect(items(await http(null, "GET", `/namespaces/${slug}/agents`))).toEqual([]);
    expect(items(await http(own, "GET", "/agents/me/namespaces"))).toEqual([]);
    // Taken out, it is told; and there is nothing there for it to leave.
    await vi.waitFor(async () => {
      const inbox = await http(inOrg, "GET", "/inbox");
      const found: Record<string, unknown>[] = Object(inbox.body["result"])["notices"] ?? [];
      // Its own acceptance is not among them: its own call already told it.
      expect(found.map((notice) => [notice["kind"], notice["detail"]])).toEqual([
        [
          "AgentInvited",
          `a member invited you into ${org}: accept, and a token that names one of its projects reads and works there`,
        ],
        ["AgentLeftNamespace", `you were taken out of ${org}: you have no standing there now`],
      ]);
    }, WAIT);
    expect(refusal(await http(own, "DELETE", `/agents/me/namespaces/${slug}`))).toEqual([
      404,
      "resource.not_found",
    ]);
  });

  it("[link.standing] an invitation that gives read alone lets the agent read and never work, and the agent leaves by itself", async () => {
    const { slug, member, projectId } = await anOrg();
    const agent = await keyAgent();
    const own = await agent.token();
    const inOrg = await agent.token(projectId);
    const invited = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
      agent: agent.handle,
      scopes: ["agent:read"],
    });
    expect(invited.body).toMatchObject({ state: "invited", scopes: ["agent:read"] });
    expect((await http(own, "PUT", `/agents/me/namespaces/${slug}`)).status).toBe(200);

    expect((await http(inOrg, "GET", `/changes?project=${projectId}`)).status).toBe(200);
    expect(reason(await http(inOrg, "POST", "/sessions", { harness: "pool" }))).toEqual([
      403,
      "auth.forbidden",
      "Refused: scope.",
    ]);

    const left = await http(own, "DELETE", `/agents/me/namespaces/${slug}`);
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ state: "ended" });
    expect(refusal(await http(inOrg, "GET", `/changes?project=${projectId}`))).toEqual([
      404,
      "resource.not_found",
    ]);
  });

  it("[link.own-namespace] a person's own namespace takes no invitation: an agent is invited into an org", async () => {
    const person = await seedUser(uniqueHandle("solo"), { role: null, signedInBy: "passkey" });
    const agent = await keyAgent();
    const invited = await http(person.token, "POST", `/namespaces/${person.handle}/agents`, {
      agent: agent.handle,
    });
    expect(refusal(invited)).toEqual([404, "resource.not_found"]);
    expect(items(await http(person.token, "GET", `/namespaces/${person.handle}/agents`))).toEqual(
      [],
    );
  });
});

describe("who is asked first, on the real namespace object", () => {
  const raise = async (
    org: NamespaceId,
    agent: AgentId | undefined,
    sponsor: UserId | undefined,
  ) => {
    const escalationId = makeId("esc", ulid());
    const answer = await namespaceStub(namespaceAddress(org)).raise({
      escalationId,
      project: makeId("prj", ulid()),
      ...(sponsor === undefined ? {} : { sponsor }),
      ...(agent === undefined ? {} : { agent }),
      raisedBy: `subj:${ulid()}`,
      ask: {
        question: "Which holds?",
        options: [
          { id: "a", label: "A", consequence: "A holds." },
          { id: "b", label: "B", consequence: "B holds." },
        ],
        about: { kind: "conflict", id: makeId("cfl", ulid()) },
        category: "ambiguous-requirement",
        evidence: [],
        precedents: [],
        default: "a",
      },
    });
    const record = decodeExit(NamespaceCodecs.raise, answer);
    if (!Exit.isSuccess(record)) throw new Error("the raise failed");
    return record.value.sponsor;
  };
  const invitations = InvitationsRpc(namespaceStub);
  const move = <A, E>(effect: Effect.Effect<A, E, Invitations>) =>
    Effect.runPromise(Effect.provide(effect, invitations));

  it("[link.asked-first] in a namespace a member invited the agent into, that member is asked first, whoever sponsors it; a pending invitation, another agent and no agent leave the sponsor given", async () => {
    const org: NamespaceId = makeId("org", ulid());
    const inviter: UserId = makeId("usr", ulid());
    const sponsor: UserId = makeId("usr", ulid());
    const joined: AgentId = makeId("agt", ulid());
    const pending: AgentId = makeId("agt", ulid());
    const stranger: AgentId = makeId("agt", ulid());
    const invite = (agentId: AgentId) =>
      move(
        Invitations.use((i) =>
          i.invite({
            namespace: org,
            agentId,
            by: inviter,
            scopes: ["agent:read", "agent:work"],
            idempotencyKey: `invite-${ulid()}`,
          }),
        ),
      );
    await invite(joined);
    await move(
      Invitations.use((i) =>
        i.accept({ namespace: org, agentId: joined, idempotencyKey: `accept-${ulid()}` }),
      ),
    );
    await invite(pending);

    expect(await raise(org, joined, sponsor)).toBe(inviter);
    expect(await raise(org, joined, undefined)).toBe(inviter);
    expect(await raise(org, pending, sponsor)).toBe(sponsor);
    expect(await raise(org, pending, undefined)).toBeUndefined();
    expect(await raise(org, stranger, sponsor)).toBe(sponsor);
    expect(await raise(org, undefined, sponsor)).toBe(sponsor);

    // Taken out, the member who invited it answers for it no longer.
    await move(
      Invitations.use((i) =>
        i.end(
          { _tag: "User", userId: inviter },
          { namespace: org, agentId: joined, idempotencyKey: `end-${ulid()}` },
        ),
      ),
    );
    expect(await raise(org, joined, sponsor)).toBe(sponsor);
  });
});

describe("[link.repair] the Projector repeats an invitation's moves in the rows the gate reads", () => {
  it("[link.repair] an invitation and its acceptance the Projector receives are written in the namespace's order, even if the inline writes never happened", async () => {
    const org: NamespaceId = makeId("org", ulid());
    const agentId: AgentId = makeId("agt", ulid());
    const by: UserId = makeId("usr", ulid());
    const envelope = (seq: number, type: string, payload: object) =>
      Schema.encodeSync(EventEnvelope)(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type,
          entity: { kind: "org", id: org },
          seq,
          at: Date.now(),
          dedupeKey: `org:${org}/repair-${seq}/${type}#1`,
          affected: [{ kind: "agent", id: agentId }],
          notified: [],
          payload: { _tag: type, namespace: org, agentId, ...payload },
        }),
      );
    const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));
    // The acceptance arrives first: it waits for its invitation's row.
    await projector.receive([envelope(2, "AgentJoinedNamespace", {})]);
    expect(await rows(NamespaceAgents.use((r) => r.find(agentId, org)))).toEqual(Option.none());
    await projector.receive([
      envelope(1, "AgentInvited", { by, scopes: ["agent:read", "agent:work"] }),
    ]);
    await vi.waitFor(async () => {
      const standing = await rows(NamespaceAgents.use((r) => r.standing(agentId, org)));
      expect(Option.getOrNull(standing)).toMatchObject({ by });
    }, WAIT);
    // Its end is repeated too.
    await projector.receive([
      envelope(3, "AgentLeftNamespace", { by: `user:${by}`, reason: "removed" }),
    ]);
    await vi.waitFor(async () => {
      expect(await rows(NamespaceAgents.use((r) => r.standing(agentId, org)))).toEqual(
        Option.none(),
      );
    }, WAIT);
  });
});
