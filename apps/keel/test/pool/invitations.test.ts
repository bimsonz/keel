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
  NamespaceId,
  type ProjectId,
  type UserId,
} from "@keeltown/core/kernel";
import { Invitations, NamespaceAgents, ProjectAgents, PROJECTOR } from "@keeltown/core/ports";
import {
  describeInvitationsContract,
  describeNamespaceAgentsContract,
  describeProjectAgentsContract,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { NamespaceAgentsD1 } from "../../src/adapters/driven/d1/namespace-agents.ts";
import { ProjectAgentsD1 } from "../../src/adapters/driven/d1/project-agents.ts";
import { InvitationsRpc } from "../../src/adapters/driven/do-rpc/invitations.ts";
import { decodeExit, NamespaceCodecs } from "../../src/rpc/index.ts";
import { freshAddress, granted, newKey, proofBy, requestToken } from "./agent-keys.ts";
import {
  BASE,
  drainAfter,
  establishProject,
  mcp,
  mcpResult,
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

const projectStub = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

// The real adapters pass the same contract suites as the in-memory ones, inside workerd.
describeNamespaceAgentsContract("d1", () => NamespaceAgentsD1(env.DB));
describeProjectAgentsContract("d1", () => ProjectAgentsD1(env.DB));
describeInvitationsContract("the object that holds each record, and d1", () =>
  Layer.mergeAll(
    InvitationsRpc(namespaceStub, projectStub),
    NamespaceAgentsD1(env.DB),
    ProjectAgentsD1(env.DB),
  ),
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
  /** A token of the agent's: for one project, or for none (its own account); for Keel's MCP when `resource` names it. */
  const token = async (project?: ProjectId, scope?: string, resource?: string) =>
    (
      await granted(
        await requestToken(agentId, account, {
          ...(project === undefined ? {} : { project }),
          ...(scope === undefined ? {} : { scope }),
          ...(resource === undefined ? {} : { resource }),
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

  it("[link.card-orgs] anyone reads on an agent's card the orgs it has joined: none while its invitation waits, the org once it accepts beside one still waiting, none again once it is taken out, and never who invited it", async () => {
    const first = await anOrg();
    const second = await anOrg();
    const agent = await keyAgent();
    const own = await agent.token();
    const card = async () => (await http(null, "GET", `/agents/${agent.agentId}`)).body;
    expect(await card()).not.toHaveProperty("orgs");

    for (const { slug, member } of [first, second]) {
      const invited = await http(member.token, "POST", `/namespaces/${slug}/agents`, {
        agent: agent.handle,
      });
      expect(invited.status).toBe(201);
    }
    expect(await card()).not.toHaveProperty("orgs");

    expect((await http(own, "PUT", `/agents/me/namespaces/${first.slug}`)).status).toBe(200);
    const joined = await card();
    expect(joined["orgs"]).toEqual([{ handle: first.slug, kind: "org" }]);
    expect(JSON.stringify(joined)).not.toContain(first.member.userId);
    // Whoever reads it reads the same card: the member who invited it, and the agent itself.
    for (const reader of [first.member.token, own])
      expect((await http(reader, "GET", `/agents/${agent.agentId}`)).body).toEqual(joined);

    expect((await http(own, "PUT", `/agents/me/namespaces/${second.slug}`)).status).toBe(200);
    expect((await card())["orgs"]).toEqual([
      { handle: first.slug, kind: "org" },
      { handle: second.slug, kind: "org" },
    ]);

    const removed = await http(
      first.member.token,
      "DELETE",
      `/namespaces/${first.slug}/agents/${agent.agentId}`,
    );
    expect(removed.status).toBe(200);
    expect((await card())["orgs"]).toEqual([{ handle: second.slug, kind: "org" }]);
    expect((await http(own, "DELETE", `/agents/me/namespaces/${second.slug}`)).status).toBe(200);
    expect(await card()).not.toHaveProperty("orgs");
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

const projectRows = <A>(effect: Effect.Effect<A, never, ProjectAgents>) =>
  Effect.runPromise(Effect.provide(effect, ProjectAgentsD1(env.DB)));

/** A person signed in by passkey just now, with two private projects in their own namespace, whose id is theirs. */
async function aSoloPerson() {
  const person = await seedUser(uniqueHandle("solo"), { role: null, signedInBy: "passkey" });
  const namespace = Schema.decodeUnknownSync(NamespaceId)(person.userId);
  const projectId: ProjectId = makeId("prj", ulid());
  const other: ProjectId = makeId("prj", ulid());
  for (const id of [projectId, other]) {
    await placeProject(id, namespace);
    await establishProject(id);
  }
  return { person, namespace, projectId, other };
}

/** Another session of the same person, signed in some other way than by a passkey. */
async function codedSession(userId: UserId): Promise<string> {
  const token = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, signedInBy) VALUES (?, ?, ?, ?, ?, ?, 'email-otp')",
  )
    .bind(ulid(), new Date(Date.now() + 3_600_000).toISOString(), token, now, now, userId)
    .run();
  return token;
}

/** The notices an agent's inbox holds, as kind and detail, read with a token of its own. */
async function noticesOf(token: string) {
  const inbox = await http(token, "GET", "/inbox");
  const found: Record<string, unknown>[] = Object(inbox.body["result"])["notices"] ?? [];
  return found;
}

describe("an agent's invitation to one project of a person's own namespace, through the real Worker", () => {
  it("[link.project-standing] invited to one project it has nothing; accepted it reads and works on that project and on nothing else of the person's; its lists by reader; taken off it is a stranger again", async () => {
    const { person, projectId, other } = await aSoloPerson();
    const agent = await keyAgent();
    const own = await agent.token();
    const onIt = await agent.token(projectId);
    const onOther = await agent.token(other);
    const read = (token = onIt, id = projectId) => http(token, "GET", `/changes?project=${id}`);
    const work = () => http(onIt, "POST", "/sessions", { harness: "pool" });
    const agents = `/projects/${projectId}/agents`;

    // Before anyone invites it the person's private project is not there for it.
    expect(refusal(await read())).toEqual([404, "resource.not_found"]);
    expect(items(await http(own, "GET", "/agents/me/projects"))).toEqual([]);

    // The person's own session that is no fresh passkey sign-in is refused the touch; nothing is written.
    const coded = await codedSession(person.userId);
    const untouched = await http(coded, "POST", agents, { agent: agent.handle });
    expect(refusal(untouched)).toEqual([403, "auth.fresh_sign_in_required"]);
    // Somebody else invites no one to it: the project is private, and not there for them.
    const outsider = await seedUser(uniqueHandle("otto"), { role: null, signedInBy: "passkey" });
    const foreign = await http(outsider.token, "POST", agents, { agent: agent.handle });
    expect(refusal(foreign)).toEqual([404, "resource.not_found"]);
    expect(await projectRows(ProjectAgents.use((r) => r.find(agent.agentId, projectId)))).toEqual(
      Option.none(),
    );

    // The person invites it by its handle.
    const invited = await http(person.token, "POST", agents, { agent: agent.handle });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({
      id: agent.agentId,
      handle: agent.handle,
      state: "invited",
      scopes: ["agent:read", "agent:work"],
      invitedBy: person.userId,
    });
    // No agent has that handle, a person's handle names no agent, and more than read and work is never given.
    const unknown = await http(person.token, "POST", agents, { agent: "agent-nobodyatall0000" });
    expect(refusal(unknown)).toEqual([404, "resource.not_found"]);
    const aHuman = await http(person.token, "POST", agents, { agent: outsider.handle });
    expect(refusal(aHuman)).toEqual([404, "resource.not_found"]);
    const tooMuch = await http(person.token, "POST", agents, {
      agent: agent.handle,
      scopes: ["agent:work"],
    });
    expect(refusal(tooMuch)).toEqual([400, "request.invalid"]);
    // Asked again on the same terms it is the same invitation; on other terms it is refused while this one stands.
    expect((await http(person.token, "POST", agents, { agent: agent.handle })).status).toBe(201);
    const changed = await http(person.token, "POST", agents, {
      agent: agent.handle,
      scopes: ["agent:read"],
    });
    expect(refusal(changed)).toEqual([409, "invitation.state_refused"]);
    expect(String(changed.body["detail"])).toContain("already has an invitation to this project");

    // A pending invitation gives nothing, and the row says so.
    expect(refusal(await read())).toEqual([404, "resource.not_found"]);
    expect(
      await projectRows(ProjectAgents.use((r) => r.standing(agent.agentId, projectId))),
    ).toEqual(Option.none());
    // The agent is told, with what it can do about it, and reads the invitation as its own.
    const notices = await vi.waitFor(async () => {
      const found = await noticesOf(onIt);
      expect(found.map((notice) => notice["kind"])).toEqual(["AgentInvitedToProject"]);
      return found;
    }, WAIT);
    expect(String(notices[0]?.["detail"])).toBe(
      `you were invited to the project ${projectId}: accept, and a token that names it reads and works there, and nowhere else in its namespace`,
    );
    const next = Array.isArray(notices[0]?.["nextActions"]) ? notices[0]["nextActions"] : [];
    expect(
      next.map((action: Record<string, unknown>) => [action["operationId"], action["args"]]),
    ).toEqual([
      ["Agents_acceptProjectInvitation", { projectId }],
      ["Agents_leaveProject", { projectId }],
    ]);
    const mine = await http(own, "GET", "/agents/me/projects");
    expect(items(mine)).toMatchObject([
      {
        project: { id: projectId, namespace: person.handle, name: projectId.toLowerCase() },
        state: "invited",
        scopes: ["agent:read", "agent:work"],
      },
    ]);
    expect(JSON.stringify(mine.body)).not.toContain(person.userId);
    // An invitation to a project is none into its namespace.
    expect(items(await http(own, "GET", "/agents/me/namespaces"))).toEqual([]);

    // A project that never invited it, and one that does not exist, read the same to it.
    const uninvited = await http(own, "PUT", `/agents/me/projects/${other}`);
    const missing = await http(own, "PUT", `/agents/me/projects/${makeId("prj", ulid())}`);
    expect(refusal(uninvited)).toEqual([404, "resource.not_found"]);
    expect({ ...uninvited.body, requestId: null, instance: null }).toEqual({
      ...missing.body,
      requestId: null,
      instance: null,
    });

    // It accepts, by the id its notice named; the token it already held works on its next request.
    const accepted = await http(own, "PUT", `/agents/me/projects/${projectId}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      project: { id: projectId, namespace: person.handle },
      state: "joined",
    });
    expect((await read()).status).toBe(200);
    expect((await work()).status).toBe(201);
    // The person's other private project is not there for it: by a token that names it, and by this one.
    expect(refusal(await read(onOther, other))).toEqual([404, "resource.not_found"]);
    expect(refusal(await read(onIt, other))).toEqual([404, "resource.not_found"]);
    expect(
      refusal(
        await http(onIt, "GET", `/namespaces/${person.handle}/projects/${other.toLowerCase()}`),
      ),
    ).toEqual([404, "resource.not_found"]);
    // Nor does it stand in the namespace: the org's list of a person's namespace holds no one.
    expect(items(await http(person.token, "GET", `/namespaces/${person.handle}/agents`))).toEqual(
      [],
    );

    // The person reads who they invited and on what; the agent, and anyone once the project is public, who has joined.
    const second = await keyAgent();
    expect(
      (await http(person.token, "POST", agents, { agent: second.handle, scopes: ["agent:read"] }))
        .status,
    ).toBe(201);
    const owners = await http(person.token, "GET", agents);
    expect(items(owners)).toMatchObject([
      { id: agent.agentId, state: "joined", invitedBy: person.userId },
      { id: second.agentId, state: "invited", scopes: ["agent:read"], invitedBy: person.userId },
    ]);
    const itsOwn = await http(onIt, "GET", agents);
    expect(items(itsOwn)).toEqual([
      expect.objectContaining({ id: agent.agentId, handle: agent.handle, state: "joined" }),
    ]);
    expect(JSON.stringify(itsOwn.body)).not.toContain(person.userId);
    expect(refusal(await http(null, "GET", agents))).toEqual([404, "resource.not_found"]);
    const shown = await http(person.token, "PUT", `/projects/${projectId}/settings`, {
      protectedPaths: [],
      maxBatchSize: 1,
      visibility: "public",
    });
    expect(shown.status).toBe(200);
    const anyones = await http(null, "GET", agents);
    expect(items(anyones)).toEqual([
      expect.objectContaining({ id: agent.agentId, handle: agent.handle, state: "joined" }),
    ]);
    expect(items(anyones)[0]).not.toHaveProperty("scopes");
    expect(JSON.stringify(anyones.body)).not.toContain(person.userId);
    // The first agent hears nothing of the second's invitation.
    expect((await noticesOf(onIt)).map((notice) => notice["kind"])).toEqual([
      "AgentInvitedToProject",
    ]);

    // Taking it off wants the touch too, and somebody else takes no one off.
    const untouchedEnd = await http(coded, "DELETE", `${agents}/${agent.agentId}`);
    expect(refusal(untouchedEnd)).toEqual([403, "auth.fresh_sign_in_required"]);
    const notTheirs = await http(outsider.token, "DELETE", `${agents}/${agent.agentId}`);
    expect(notTheirs.status).toBe(403);
    expect((await work()).status).toBe(201);

    // The person takes it off; from its next request it is a stranger there, and it is told.
    const removed = await http(person.token, "DELETE", `${agents}/${agent.agentId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ id: agent.agentId, state: "ended" });
    expect(reason(await work())).toEqual([403, "auth.forbidden", "Refused: foreign-project."]);
    expect(items(await http(null, "GET", agents))).toEqual([]);
    expect(items(await http(own, "GET", "/agents/me/projects"))).toEqual([]);
    await vi.waitFor(async () => {
      expect((await noticesOf(onIt)).map((notice) => [notice["kind"], notice["detail"]])).toEqual([
        [
          "AgentInvitedToProject",
          `you were invited to the project ${projectId}: accept, and a token that names it reads and works there, and nowhere else in its namespace`,
        ],
        [
          "AgentLeftProject",
          `you were taken off the project ${projectId}: you have no standing there now`,
        ],
      ]);
    }, WAIT);
    expect(refusal(await http(own, "DELETE", `/agents/me/projects/${projectId}`))).toEqual([
      404,
      "resource.not_found",
    ]);
  });

  it("[link.project-standing] an invitation to a project that gives read alone lets the agent read and never work, and the agent leaves by itself", async () => {
    const { person, projectId } = await aSoloPerson();
    const agent = await keyAgent();
    const own = await agent.token();
    const onIt = await agent.token(projectId);
    const invited = await http(person.token, "POST", `/projects/${projectId}/agents`, {
      agent: agent.handle,
      scopes: ["agent:read"],
    });
    expect(invited.body).toMatchObject({ state: "invited", scopes: ["agent:read"] });
    expect((await http(own, "PUT", `/agents/me/projects/${projectId}`)).status).toBe(200);

    expect((await http(onIt, "GET", `/changes?project=${projectId}`)).status).toBe(200);
    expect(reason(await http(onIt, "POST", "/sessions", { harness: "pool" }))).toEqual([
      403,
      "auth.forbidden",
      "Refused: scope.",
    ]);

    const left = await http(own, "DELETE", `/agents/me/projects/${projectId}`);
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ state: "ended" });
    expect(refusal(await http(onIt, "GET", `/changes?project=${projectId}`))).toEqual([
      404,
      "resource.not_found",
    ]);
  });

  it("[link.project-own-only] an org's project takes no such invitation, whoever asks, and holds no such agents: an org takes an agent whole", async () => {
    const { org, member, projectId } = await anOrg();
    const agent = await keyAgent();
    const invited = await http(member.token, "POST", `/projects/${projectId}/agents`, {
      agent: agent.handle,
    });
    expect(refusal(invited)).toEqual([404, "resource.not_found"]);
    const owner = await seedUser(uniqueHandle("olga"), {
      org,
      role: "owner",
      signedInBy: "passkey",
    });
    expect(
      refusal(
        await http(owner.token, "POST", `/projects/${projectId}/agents`, { agent: agent.handle }),
      ),
    ).toEqual([404, "resource.not_found"]);
    expect(
      refusal(await http(owner.token, "DELETE", `/projects/${projectId}/agents/${agent.agentId}`)),
    ).toEqual([404, "resource.not_found"]);
    expect(items(await http(member.token, "GET", `/projects/${projectId}/agents`))).toEqual([]);
    expect(await projectRows(ProjectAgents.use((r) => r.inProject(projectId)))).toEqual([]);
  });
});

describe("who is asked first, on the real namespace object", () => {
  const raise = async (
    org: NamespaceId,
    agent: AgentId | undefined,
    sponsor: UserId | undefined,
    project: ProjectId = makeId("prj", ulid()),
  ) => {
    const escalationId = makeId("esc", ulid());
    const answer = await namespaceStub(namespaceAddress(org)).raise({
      escalationId,
      project,
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
  const invitations = InvitationsRpc(namespaceStub, projectStub);
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

  it("[link.project-asked-first] in a person's namespace, the person who invited the agent to a project is asked first about that project, whoever sponsors it; on another of their projects, pending, or taken off, the sponsor given is", async () => {
    const person: UserId = makeId("usr", ulid());
    const namespace = Schema.decodeUnknownSync(NamespaceId)(person);
    const sponsor: UserId = makeId("usr", ulid());
    const here: ProjectId = makeId("prj", ulid());
    const there: ProjectId = makeId("prj", ulid());
    const joined: AgentId = makeId("agt", ulid());
    const pending: AgentId = makeId("agt", ulid());
    const invite = (agentId: AgentId) =>
      move(
        Invitations.use((i) =>
          i.invite({
            namespace,
            projectId: here,
            agentId,
            by: person,
            scopes: ["agent:read", "agent:work"],
            idempotencyKey: `invite-${ulid()}`,
          }),
        ),
      );
    await invite(joined);
    await move(
      Invitations.use((i) =>
        i.accept({
          namespace,
          projectId: here,
          agentId: joined,
          idempotencyKey: `accept-${ulid()}`,
        }),
      ),
    );
    await invite(pending);

    expect(await raise(namespace, joined, sponsor, here)).toBe(person);
    expect(await raise(namespace, joined, undefined, here)).toBe(person);
    // The invitation is to one project: about another of the person's, it says nothing.
    expect(await raise(namespace, joined, sponsor, there)).toBe(sponsor);
    expect(await raise(namespace, joined, undefined, there)).toBeUndefined();
    expect(await raise(namespace, pending, sponsor, here)).toBe(sponsor);
    expect(await raise(namespace, undefined, sponsor, here)).toBe(sponsor);

    await move(
      Invitations.use((i) =>
        i.end(
          { _tag: "User", userId: person },
          { namespace, projectId: here, agentId: joined, idempotencyKey: `end-${ulid()}` },
        ),
      ),
    );
    expect(await raise(namespace, joined, sponsor, here)).toBe(sponsor);
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

describe("[link.project-repair] the Projector repeats a project invitation's moves in the rows the gate reads", () => {
  it("[link.project-repair] an invitation to a project and its acceptance the Projector receives are written in the project's order, even if the inline writes never happened", async () => {
    const person: UserId = makeId("usr", ulid());
    const projectId: ProjectId = makeId("prj", ulid());
    const agentId: AgentId = makeId("agt", ulid());
    const envelope = (seq: number, type: string, payload: object) =>
      Schema.encodeSync(EventEnvelope)(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type,
          entity: { kind: "project", id: projectId },
          project: projectId,
          seq,
          at: Date.now(),
          dedupeKey: `project:${projectId}/repair-${seq}/${type}#1`,
          affected: [{ kind: "agent", id: agentId }],
          notified: [],
          payload: { _tag: type, projectId, namespace: person, agentId, ...payload },
        }),
      );
    const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));
    // The acceptance arrives first: it waits for its invitation's row.
    await projector.receive([envelope(2, "AgentJoinedProject", {})]);
    expect(await projectRows(ProjectAgents.use((r) => r.find(agentId, projectId)))).toEqual(
      Option.none(),
    );
    await projector.receive([
      envelope(1, "AgentInvitedToProject", { by: person, scopes: ["agent:read", "agent:work"] }),
    ]);
    await vi.waitFor(async () => {
      const standing = await projectRows(ProjectAgents.use((r) => r.standing(agentId, projectId)));
      expect(Option.getOrNull(standing)).toMatchObject({ by: person });
    }, WAIT);
    // It wrote nothing into the namespace's own rows.
    expect(await rows(NamespaceAgents.use((r) => r.ofAgent(agentId)))).toEqual([]);
    // Its end is repeated too.
    await projector.receive([
      envelope(3, "AgentLeftProject", { by: `user:${person}`, reason: "removed" }),
    ]);
    await vi.waitFor(async () => {
      expect(await projectRows(ProjectAgents.use((r) => r.standing(agentId, projectId)))).toEqual(
        Option.none(),
      );
    }, WAIT);
  });
});

/** What `whoami` tells the agent of its invitations: the counts, and the reads its `next` names. */
const told = async (token: string) => {
  const answer = await http(token, "GET", "/agents/me");
  const result = Object(answer.body["result"]);
  const next: unknown = answer.body["next"];
  return {
    invitations: result["invitations"],
    reads: (Array.isArray(next) ? next : []).map((action) => Object(action)["operationId"]),
  };
};

describe("whoami says an invitation is waiting, through the real Worker", () => {
  it("[whoami.invited] an agent invited into an org and to a project is told one of each and the read for each; accepted, and ended, it is told none, and once in the org it is pointed at the projects it can reach", async () => {
    const { slug, member } = await anOrg();
    const { person, projectId } = await aSoloPerson();
    const agent = await keyAgent();
    const own = await agent.token();
    // Nobody stands behind it, so `askSponsor` leads every answer; standing nowhere, it is told who invites it.
    expect(await told(own)).toEqual({
      invitations: { namespaces: 0, projects: 0 },
      reads: ["askSponsor", undefined, "inbox"],
    });

    expect(
      (await http(member.token, "POST", `/namespaces/${slug}/agents`, { agent: agent.handle }))
        .status,
    ).toBe(201);
    expect(
      (await http(person.token, "POST", `/projects/${projectId}/agents`, { agent: agent.handle }))
        .status,
    ).toBe(201);
    expect(await told(own)).toEqual({
      invitations: { namespaces: 1, projects: 1 },
      reads: ["askSponsor", "Agents_listNamespaces", "Agents_listProjects"],
    });

    expect((await http(own, "PUT", `/agents/me/namespaces/${slug}`)).status).toBe(200);
    expect(await told(own)).toEqual({
      invitations: { namespaces: 0, projects: 1 },
      reads: ["askSponsor", "Agents_listProjects", "Agents_listReachableProjects"],
    });
    expect(
      (await http(person.token, "DELETE", `/projects/${projectId}/agents/${agent.agentId}`)).status,
    ).toBe(200);
    expect(await told(own)).toEqual({
      invitations: { namespaces: 0, projects: 0 },
      reads: ["askSponsor", "Agents_listReachableProjects"],
    });
  });

  it("[inbox.own-namespace] a token that names no project reads the agent's own inbox, over REST and MCP, and is told there the moment an org invites it", async () => {
    const { slug, member } = await anOrg();
    const agent = await keyAgent();
    const own = await agent.token();
    const head = await http(own, "GET", "/inbox?cursor=end");
    expect(head.status).toBe(200);
    const cursor = String(Object(head.body["result"])["cursor"]);
    const door = await agent.token(undefined, undefined, `${BASE}/mcp`);
    expect((await tool(door, "inbox", { cursor: "end" })).refused).toBe(false);

    expect(
      (await http(member.token, "POST", `/namespaces/${slug}/agents`, { agent: agent.handle }))
        .status,
    ).toBe(201);
    await vi.waitFor(async () => {
      const page = await http(own, "GET", `/inbox?cursor=${cursor}`);
      expect(page.status).toBe(200);
      const notices: unknown = Object(page.body["result"])["notices"];
      expect((Array.isArray(notices) ? notices : []).map((notice) => notice["kind"])).toEqual([
        "AgentInvited",
      ]);
    }, WAIT);
  });
});

/** One tool of Keel's MCP, called as an agent's client calls it: its answer, refused or not. */
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const result = await mcpResult(await mcp(token, "tools/call", { name, arguments: args }, name));
  return { refused: result["isError"] === true, body: Object(result["structuredContent"]) };
};

describe("an agent sets itself up through Keel's MCP alone", () => {
  it("[mcp.set-up] signed up by key, it is told to declare a change on the project its token names, then to ask a person to sponsor it and an org's member to invite it by its handle; invited, it reads the invitation and accepts it through Keel's tools, and is then pointed at the projects it can reach", async () => {
    const { slug, member } = await anOrg();
    const agent = await keyAgent();
    // Its client's token names a project of its own namespace, as a key agent's MCP token does before any org takes it in.
    const ownProject: ProjectId = makeId("prj", ulid());
    await placeProject(ownProject, agent.agentId);
    await establishProject(ownProject);
    const own = await agent.token(ownProject, undefined, `${BASE}/mcp`);

    const first = await tool(own, "whoami");
    const named = `${agent.handle}/${ownProject.toLowerCase()}`;
    expect(first.body["summary"]).toContain(
      ` This token is for ${named} (${ownProject}), where you can work: declare a change there, and ask why about a file before you change it. Nobody stands behind you yet: ask a person to sponsor you. You work only in your own namespace, ${agent.handle}: `,
    );
    expect(first.body["next"]).toMatchObject([
      { kind: "call", operationId: "declare", title: expect.stringContaining(named) },
      { kind: "call", operationId: "askSponsor" },
      { kind: "escalate", title: expect.stringContaining(`by your handle ${agent.handle}`) },
    ]);
    // A token that asks only to read there is not sent to declare.
    const reader = await tool(await agent.token(ownProject, "agent:read", `${BASE}/mcp`), "whoami");
    expect(reader.body["summary"]).not.toMatch(/This token is for/);
    expect(reader.body["next"]).toMatchObject([
      { operationId: "askSponsor" },
      { kind: "escalate" },
      { operationId: "inbox" },
    ]);
    const asked = await tool(own, "askSponsor");
    expect(asked.refused).toBe(false);
    expect(String(Object(asked.body["result"])["url"])).toContain(
      `/sponsor#agent=${agent.agentId}&code=`,
    );
    expect(asked.body["next"]).toMatchObject([
      { kind: "escalate" },
      { operationId: "inbox" },
      { operationId: "whoami" },
    ]);

    expect(
      (await http(member.token, "POST", `/namespaces/${slug}/agents`, { agent: agent.handle }))
        .status,
    ).toBe(201);
    const invited = await tool(own, "whoami");
    expect(invited.body["summary"]).not.toMatch(/own namespace/);
    expect(invited.body["next"]).toMatchObject([
      { operationId: "declare" },
      { operationId: "askSponsor" },
      { operationId: "Agents_listNamespaces" },
    ]);
    expect(invited.body["next"]).toHaveLength(3);

    const listed = await tool(own, "Agents_listNamespaces");
    expect(listed.body["items"]).toMatchObject([
      { namespace: { handle: slug }, state: "invited", scopes: ["agent:read", "agent:work"] },
    ]);
    const accepted = await tool(own, "Agents_acceptInvitation", {
      namespace: slug,
      "idempotency-key": `accept-${ulid()}`,
    });
    expect([accepted.refused, accepted.body["state"]]).toEqual([false, "joined"]);

    const placed = await tool(own, "whoami");
    expect(placed.body["summary"]).not.toMatch(/invitation|own namespace/);
    expect(placed.body["next"]).toMatchObject([
      { operationId: "declare" },
      { operationId: "askSponsor" },
      { operationId: "Agents_listReachableProjects" },
    ]);
    expect(placed.body["next"]).toHaveLength(3);
  });
});

const byFirst = (a: readonly unknown[], b: readonly unknown[]) =>
  String(a[0]).localeCompare(String(b[0]));

describe("an agent lists the projects it can reach, through the real Worker", () => {
  it("[agents.reach] its own namespace's projects, every project of each org it joined and each person's project it joined, with their ids, over REST and MCP; a pending invitation, an org that never asked, an org whose inviter left and an org that took it out reach nothing", async () => {
    const agent = await keyAgent();
    const own = await agent.token();
    const mine: ProjectId = makeId("prj", ulid());
    await placeProject(mine, Schema.decodeUnknownSync(NamespaceId)(agent.agentId));
    const joined = await anOrg();
    const second: ProjectId = makeId("prj", ulid());
    await placeProject(second, joined.org);
    const pending = await anOrg();
    const stranger = await anOrg();
    const left = await anOrg();
    const revoked = await anOrg();
    const { person, projectId: personal, other } = await aSoloPerson();

    for (const org of [joined, pending, left, revoked])
      expect(
        (
          await http(org.member.token, "POST", `/namespaces/${org.slug}/agents`, {
            agent: agent.handle,
          })
        ).status,
      ).toBe(201);
    expect(
      (await http(person.token, "POST", `/projects/${personal}/agents`, { agent: agent.handle }))
        .status,
    ).toBe(201);
    for (const org of [joined, left, revoked])
      expect((await http(own, "PUT", `/agents/me/namespaces/${org.slug}`)).status).toBe(200);
    expect((await http(own, "PUT", `/agents/me/projects/${personal}`)).status).toBe(200);
    // The member who invited it into `left` leaves that org: the agent reaches none of it any more.
    await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?")
      .bind(left.org, left.member.userId)
      .run();
    // The member who invited it into `revoked` takes it out again.
    expect(
      (
        await http(
          revoked.member.token,
          "DELETE",
          `/namespaces/${revoked.slug}/agents/${agent.agentId}`,
        )
      ).status,
    ).toBe(200);

    const listed = await http(own, "GET", "/agents/me/reachable-projects");
    expect(listed.status).toBe(200);
    const both = ["agent:read", "agent:work"];
    const reached = items(listed).map((item) => [
      String(Object(item["project"])["id"]),
      item["through"],
      item["scopes"],
    ]);
    expect(reached.toSorted(byFirst)).toEqual(
      [
        [mine, "own", both],
        [joined.projectId, "org", both],
        [second, "org", both],
        [personal, "project", both],
      ].toSorted(byFirst),
    );
    const ids = reached.map(([id]) => id);
    for (const unreached of [
      pending.projectId,
      stranger.projectId,
      left.projectId,
      revoked.projectId,
      other,
    ])
      expect(ids).not.toContain(unreached);

    const door = await agent.token(undefined, undefined, `${BASE}/mcp`);
    const tooled = await tool(door, "Agents_listReachableProjects");
    expect(tooled.refused).toBe(false);
    expect(tooled.body["items"]).toEqual(listed.body["items"]);
  });
});
