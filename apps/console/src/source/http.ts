// Keel, as the page reaches it: on the page's own origin, under /v1, as
// whoever is signed in. The session is a cookie Keel set, which the browser
// sends with every request to its own origin and no script can read; the page
// puts no credential of its own on anything. A reader with no session is a
// visitor, and Keel reads a visitor what is public.
//
// A project is found by its namespace's handle and its name (`GET /v1/
// namespaces/{handle}/projects/{name}`), and everything after is read by the
// id Keel answered: its log by
// cursor, long-polling at the tail, its repository, a verdict's evidence. A
// ruling is Keel's own operation, and Keel decides whether this reader may
// give it.
//
// What the API does not offer yet is absent here too, honestly: there are no
// observations, and a change's diff is refused. The console's views show
// their empty states for those.

import { EVENT_TYPES } from "../contract/envelope.ts";
import type { AnyEvent } from "../contract/events.ts";
import type {
  AgentCard,
  AgentProfile,
  Agents_approveSponsorInput,
  CloudflareConnect,
  Credentials,
  Delivery_beginCloudflareConnectInput,
  Delivery_deleteCredentialInput,
  Delivery_deleteDeployTargetInput,
  Delivery_listCredentialsInput,
  Delivery_listDeployTargetsInput,
  Delivery_putDeployTargetInput,
  DeployTargetView,
  DeployTargets,
  Operator_createProjectInput,
  Agents_endSponsorshipInput,
  EscalationPage,
  EscalationView,
  EventPage,
  EventRecord,
  Inbox_listEventsInput,
  LatticeSet,
  NamespaceAgent,
  NamespaceAgents,
  NamespaceView,
  Namespaces_inviteAgentInput,
  DecisionPage,
  DecisionView,
  Memory_getDecisionInput,
  Memory_listDecisionsInput,
  Namespaces_listAgentsInput,
  Namespaces_removeAgentInput,
  Operator_giveRulingInput,
  Operator_listEscalationsInput,
  Operator_putSettingsInput,
  Operator_syncUpstreamInput,
  Operator_reinstateAgentInput,
  Operator_suspendAgentInput,
  ProjectPage,
  ProjectSettings,
  ProjectView,
  Probes_getProbeSourceInput,
  UpstreamSync,
  ProjectAgent,
  ProjectAgents,
  Projects_inviteAgentInput,
  Projects_listAgentsInput,
  Projects_removeAgentInput,
  ProbeSource,
  RepoBlob,
  RepoCommitDiff,
  RepoCommitPage,
  RepoTree,
  SponsoredAgents,
  Repo_getBlobInput,
  Repo_getTreeInput,
  Repo_listCommitsInput,
  VerdictView,
} from "../contract/keel/index.ts";
import { type KeelRepository, RepoRefused } from "./repository.ts";
import {
  type ChangeDiff,
  type KeelAgents,
  type KeelCommands,
  type KeelCredentials,
  type KeelDirectory,
  type KeelInvited,
  type KeelOrgAgents,
  type KeelRemembered,
  type KeelSponsorship,
  type KeelEventSource,
  KeelRefused,
  type KeelResources,
  type KeelSettings,
  type KeelSync,
  type KeelTargeted,
  type Page,
  type ReadRequest,
  type RulingCommand,
  type SourceDescriptor,
} from "./types.ts";

export interface HttpOptions {
  /** Where Keel is. The page's own origin, so nothing, unless a test says otherwise. */
  origin?: string;
  fetch?: typeof fetch;
}

export type HttpSource = KeelEventSource &
  KeelResources &
  KeelRepository &
  KeelCommands &
  KeelSettings &
  KeelSync &
  KeelInvited &
  KeelRemembered &
  KeelTargeted &
  KeelAgents;

const KNOWN: ReadonlySet<string> = new Set(EVENT_TYPES);

/** An entry of the log, as the console reads one. An event its catalogue does not know yet is left out, not guessed at. */
function toEvent(record: EventRecord): AnyEvent | null {
  if (!KNOWN.has(record.type)) return null;
  // Keel validates each payload against its catalogue, and `type` is the payload's own tag.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wire boundary: the type was checked by name above
  return record as unknown as AnyEvent;
}

/** A query string of what was given, by Keel's own names for an operation's inputs. */
const queryOf = (input: Record<string, string | number | undefined>): string => {
  const query = new URLSearchParams(
    Object.entries(input).flatMap(([name, value]) =>
      value === undefined || value === "" ? [] : [[name, String(value)]],
    ),
  ).toString();
  return query === "" ? "" : `?${query}`;
};

/** What the console reads of Keel's problem answer: its words, its code, and the next actions it always carries. */
interface Problem {
  title?: unknown;
  detail?: unknown;
  code?: unknown;
  nextActions?: unknown;
}

/** Keel's refusal, as it words one: its detail or its title, its code, and the ways forward it gave. */
async function refusalOf(response: Response): Promise<KeelRefused> {
  const problem: Problem = await response.json().catch(() => ({}));
  const said = [problem.detail, problem.title].find(
    (words): words is string => typeof words === "string" && words !== "",
  );
  const next = Array.isArray(problem.nextActions) ? problem.nextActions : [];
  return new KeelRefused(
    said ?? `Keel answered ${response.status}`,
    typeof problem.code === "string" ? problem.code : "",
    response.status,
    next.flatMap((action: unknown) =>
      typeof action === "object" &&
      action !== null &&
      "title" in action &&
      typeof action.title === "string"
        ? [action.title]
        : [],
    ),
  );
}

/** Keel's answer to a read, as the JSON it is. Whatever answers under /v1 with anything else is not Keel. */
async function answered<Body>(response: Response): Promise<Body> {
  try {
    const body: Body = await response.json();
    return body;
  } catch {
    throw new Error("What answered at /v1 was not Keel");
  }
}

/** A read of Keel, with nothing added to it: what the browser sends to its own origin is all Keel is shown. */
function reader(options: HttpOptions): (path: string, signal?: AbortSignal) => Promise<Response> {
  const request = options.fetch ?? fetch;
  const origin = options.origin ?? "";
  return (path, signal) => request(`${origin}${path}`, signal === undefined ? {} : { signal });
}

/**
 * Standing behind an agent. The card is a read anyone may make, by the agent's id. The approval carries the
 * code in its body and in nothing else: not the path, not the query, not a header. Its key is made for the one
 * attempt, of nothing the code could be read from.
 */
export function createHttpSponsorship(options: HttpOptions = {}): KeelSponsorship {
  const read = reader(options);
  const request = options.fetch ?? fetch;
  const origin = options.origin ?? "";
  /**
   * One of a sponsor's moves on an agent: Keel's own operation at its own address, with a key made for the one
   * attempt and nothing of the page's beside it. Keel answers the agent as it then stands.
   */
  const moved = async (
    method: "DELETE" | "POST",
    path: string,
    key: string,
    body?: object,
  ): Promise<AgentProfile> => {
    const response = await request(`${origin}/v1/agents/${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "idempotency-key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await refusalOf(response);
    return answered<AgentProfile>(response);
  };
  return {
    async findAgent(agentId, signal) {
      const response = await read(`/v1/agents/${encodeURIComponent(agentId)}`, signal);
      // An agent Keel knows none of by that id.
      if (response.status === 404) return null;
      if (!response.ok) throw await refusalOf(response);
      return answered<AgentCard>(response);
    },
    async approve(agentId, code) {
      const {
        agentId: named,
        "idempotency-key": key,
        ...body
      }: Agents_approveSponsorInput = {
        agentId,
        "idempotency-key": `console:sponsor:${crypto.randomUUID()}`,
        code,
      };
      const response = await request(`${origin}/v1/agents/${encodeURIComponent(named)}/sponsor`, {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await refusalOf(response);
    },
    async listSponsored(signal) {
      const response = await read("/v1/agents/sponsored", signal);
      if (!response.ok) throw await refusalOf(response);
      return (await answered<SponsoredAgents>(response)).items;
    },
    pause(agentId, reason) {
      const {
        agentId: named,
        "idempotency-key": key,
        ...body
      }: Operator_suspendAgentInput = {
        agentId,
        "idempotency-key": `console:pause:${crypto.randomUUID()}`,
        reason,
      };
      return moved("POST", `${encodeURIComponent(named)}/suspend`, key, body);
    },
    unpause(agentId) {
      const { agentId: named, "idempotency-key": key }: Operator_reinstateAgentInput = {
        agentId,
        "idempotency-key": `console:unpause:${crypto.randomUUID()}`,
      };
      return moved("POST", `${encodeURIComponent(named)}/reinstate`, key);
    },
    end(agentId) {
      const { agentId: named, "idempotency-key": key }: Agents_endSponsorshipInput = {
        agentId,
        "idempotency-key": `console:end:${crypto.randomUUID()}`,
      };
      return moved("DELETE", `${encodeURIComponent(named)}/sponsor`, key);
    },
  };
}

/** Where Keel keeps an org's agents. */
const agentsAt = (org: string): string => `/v1/namespaces/${encodeURIComponent(org)}/agents`;

/**
 * The agents in an org: Keel's own three operations at their own addresses. An invitation names the agent and
 * what it is given in its body; a removal names the agent in its path. Each carries a key made for the one
 * attempt and nothing of the page's beside it: Keel takes it as whoever is signed in.
 */
export function createHttpOrgAgents(options: HttpOptions = {}): KeelOrgAgents {
  const read = reader(options);
  const request = options.fetch ?? fetch;
  const origin = options.origin ?? "";
  return {
    async listAgents(org, signal) {
      const input: Namespaces_listAgentsInput = { handle: org };
      const response = await read(agentsAt(input.handle), signal);
      if (!response.ok) throw await refusalOf(response);
      return (await answered<NamespaceAgents>(response)).items;
    },
    async inviteAgent(org, agent, scopes) {
      const {
        handle,
        "idempotency-key": key,
        ...body
      }: Namespaces_inviteAgentInput = {
        handle: org,
        "idempotency-key": `console:invite-agent:${crypto.randomUUID()}`,
        agent,
        scopes: [...scopes],
      };
      const response = await request(`${origin}${agentsAt(handle)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await refusalOf(response);
      return answered<NamespaceAgent>(response);
    },
    async removeAgent(org, agentId) {
      const {
        handle,
        agentId: named,
        "idempotency-key": key,
      }: Namespaces_removeAgentInput = {
        handle: org,
        agentId,
        "idempotency-key": `console:remove-agent:${crypto.randomUUID()}`,
      };
      const response = await request(`${origin}${agentsAt(handle)}/${encodeURIComponent(named)}`, {
        method: "DELETE",
        headers: { "idempotency-key": key },
      });
      if (!response.ok) throw await refusalOf(response);
      return answered<NamespaceAgent>(response);
    },
  };
}

/** Where a namespace keeps its credentials, by its handle. */
const credentialsAt = (handle: string): string =>
  `/v1/namespaces/${encodeURIComponent(handle)}/credentials`;

/**
 * A namespace's credentials, by the namespace's handle: Keel's list and its delete. No token passes through the
 * console: Keel mints one when an owner connects a Cloudflare account to a project.
 */
export function createHttpCredentials(options: HttpOptions = {}): KeelCredentials {
  const read = reader(options);
  const request = options.fetch ?? fetch;
  const origin = options.origin ?? "";
  return {
    async listCredentials(namespace, signal) {
      const input: Delivery_listCredentialsInput = { handle: namespace };
      const response = await read(credentialsAt(input.handle), signal);
      if (!response.ok) throw await refusalOf(response);
      return (await answered<Credentials>(response)).credentials;
    },
    async removeCredential(namespace, credentialId) {
      const input: Delivery_deleteCredentialInput = { handle: namespace, credentialId };
      const response = await request(
        `${origin}${credentialsAt(input.handle)}/${encodeURIComponent(input.credentialId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw await refusalOf(response);
    },
  };
}

export function createHttpDirectory(options: HttpOptions = {}): KeelDirectory {
  const read = reader(options);
  return {
    async findNamespace(handle, signal) {
      const response = await read(`/v1/namespaces/${encodeURIComponent(handle)}`, signal);
      // A handle nobody has.
      if (response.status === 404) return null;
      if (!response.ok) throw await refusalOf(response);
      return answered<NamespaceView>(response);
    },
    async findProject(namespace, name, signal) {
      const response = await read(
        `/v1/namespaces/${encodeURIComponent(namespace)}/projects/${encodeURIComponent(name)}`,
        signal,
      );
      // Keel answers a project it does not show this reader as it answers one that is not there.
      if (response.status === 404) return null;
      if (!response.ok) throw await refusalOf(response);
      return answered<ProjectView>(response);
    },
    async listProjects(signal) {
      const listed: ProjectView[] = [];
      let cursor: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- a page names the next one
        const response = await read(`/v1/projects${queryOf({ cursor, limit: 100 })}`, signal);
        // oxlint-disable-next-line no-await-in-loop -- as above
        if (!response.ok) throw await refusalOf(response);
        // oxlint-disable-next-line no-await-in-loop -- as above
        const page = await answered<Partial<ProjectPage>>(response);
        listed.push(...(page.items ?? []));
        cursor = page.nextCursor;
      } while (cursor !== undefined && cursor !== "");
      return listed;
    },
    async listWaiting(signal) {
      const listed: EscalationView[] = [];
      let cursor: string | undefined;
      do {
        // The operation's own input. A page may hold fewer than its limit while its cursor says more follow.
        const input: Operator_listEscalationsInput = {
          state: "open",
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        };
        // oxlint-disable-next-line no-await-in-loop -- a page names the next one
        const response = await read(`/v1/escalations${queryOf({ ...input })}`, signal);
        // oxlint-disable-next-line no-await-in-loop -- as above
        if (!response.ok) throw await refusalOf(response);
        // oxlint-disable-next-line no-await-in-loop -- as above
        const page = await answered<Partial<EscalationPage>>(response);
        listed.push(...(page.items ?? []));
        cursor = page.nextCursor;
      } while (cursor !== undefined && cursor !== "");
      return listed;
    },
    async readOwnFeed(asked) {
      // No project is named: Keel reads a signed-in person every project it may, each as it reads them there.
      const input: Inbox_listEventsInput = {
        limit: Math.min(asked.limit ?? 500, 500),
        ...(asked.cursor === undefined || asked.cursor === "" ? {} : { cursor: asked.cursor }),
        ...((asked.waitSec ?? 0) > 0 ? { wait: Math.min(asked.waitSec ?? 0, 30) } : {}),
      };
      const response = await read(`/v1/events${queryOf({ ...input })}`, asked.signal);
      if (!response.ok) throw await refusalOf(response);
      const page = await answered<Partial<EventPage>>(response);
      if (page.items === undefined || typeof page.nextCursor !== "string")
        throw new Error("reading events failed: the page has no cursor");
      return { items: page.items.map((record) => record.type), nextCursor: page.nextCursor };
    },
    async createProject(asked, key) {
      // The operation's whole input: the attempt's key as its header, and whose, what name and how it starts
      // as its body. Nothing of the page's own rides beside them: Keel makes the project as whoever is signed in.
      const { "idempotency-key": attempt, ...body }: Operator_createProjectInput = {
        ...asked,
        "idempotency-key": key,
      };
      const response = await (options.fetch ?? fetch)(`${options.origin ?? ""}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": attempt },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await refusalOf(response);
      return answered<ProjectView>(response);
    },
  };
}

/** One project's log, repository and questions, read from Keel as whoever is signed in. */
export function createHttpSource(project: ProjectView, options: HttpOptions = {}): HttpSource {
  const request = options.fetch ?? fetch;
  const origin = options.origin ?? "";
  const read = reader(options);

  /**
   * One of Keel's reads of the project's repository. Keel says why it refuses one by its own code: no such
   * project for this reader, no such ref, no such path.
   */
  const repo = async <Body>(
    projectId: string,
    rest: string,
    signal?: AbortSignal,
  ): Promise<Body> => {
    const response = await read(
      `/v1/projects/${encodeURIComponent(projectId)}/repo${rest}`,
      signal,
    );
    if (!response.ok) {
      const refusal: { code?: unknown } = await response.json().catch(() => ({}));
      throw new RepoRefused(typeof refusal.code === "string" ? refusal.code : "", response.status);
    }
    const body: Body = await response.json();
    return body;
  };

  const events = async (asked: ReadRequest): Promise<Page<AnyEvent>> => {
    // The operation's own input, by Keel's names for it. The log asked for is this project's and no other's.
    const input: Inbox_listEventsInput = {
      project: project.id,
      limit: Math.min(asked.limit ?? 500, 500),
      ...(asked.cursor === undefined || asked.cursor === "" ? {} : { cursor: asked.cursor }),
      ...((asked.waitSec ?? 0) > 0 ? { wait: Math.min(asked.waitSec ?? 0, 30) } : {}),
    };
    const response = await read(`/v1/events${queryOf({ ...input })}`, asked.signal);
    if (!response.ok) throw await refusalOf(response);
    const page: Partial<EventPage> = await response.json();
    // Keel's page always says where to read next. A reader that carried on without that would start again from
    // the beginning, for ever, so a page that does not is refused.
    if (page.items === undefined || typeof page.nextCursor !== "string")
      throw new Error("reading events failed: the page has no cursor");
    return {
      items: page.items.flatMap((record) => toEvent(record) ?? []),
      nextCursor: page.nextCursor,
    };
  };

  /** The open questions Keel lists to this reader: theirs to answer, whatever their role. */
  const putToReader = new Set<string>();
  const maintainer = project.viewer?.role === "owner" || project.viewer?.role === "maintainer";

  const descriptor: SourceDescriptor = { mode: "live", project };

  return {
    descriptor,
    readEvents: (asked = {}) => events(asked),
    readObservations: (asked = {}) =>
      Promise.resolve({ items: [], nextCursor: asked.cursor ?? "" }),
    getTree: (projectId, at, signal) =>
      repo<RepoTree>(
        projectId,
        `/tree${queryOf({ ...at } satisfies Omit<Repo_getTreeInput, "projectId">)}`,
        signal,
      ),
    getBlob: (projectId, at, signal) =>
      repo<RepoBlob>(
        projectId,
        `/blob${queryOf({ ...at } satisfies Omit<Repo_getBlobInput, "projectId">)}`,
        signal,
      ),
    getCommits: (projectId, asked, signal) =>
      repo<RepoCommitPage>(
        projectId,
        `/commits${queryOf({ ...asked } satisfies Omit<Repo_listCommitsInput, "projectId">)}`,
        signal,
      ),
    getCommit: (projectId, sha, signal) =>
      repo<RepoCommitDiff>(projectId, `/commits/${encodeURIComponent(sha)}`, signal),
    getDiff: (changeId: string): Promise<ChangeDiff> =>
      Promise.reject(new Error(`the API has no diff endpoint yet (${changeId})`)),
    async getProbeSource(probeId: string, signal?: AbortSignal): Promise<ProbeSource> {
      // The operation's own input: the probe in the path, and the project it is a probe of.
      const { probeId: id, ...query }: Probes_getProbeSourceInput = {
        probeId,
        project: project.id,
      };
      const response = await read(
        `/v1/probes/${encodeURIComponent(id)}/source${queryOf({ ...query })}`,
        signal,
      );
      if (!response.ok) throw await refusalOf(response);
      return answered<ProbeSource>(response);
    },
    async getLattices(signal?: AbortSignal): Promise<LatticeSet> {
      const response = await read("/v1/lattices", signal);
      if (!response.ok) throw new Error(`reading lattices failed: ${response.status}`);
      const lattices: LatticeSet = await response.json();
      return lattices;
    },
    async getVerdict(verdictId: string, signal?: AbortSignal): Promise<VerdictView> {
      const response = await read(`/v1/verdicts/${encodeURIComponent(verdictId)}`, signal);
      if (!response.ok) throw new Error(`reading verdict ${verdictId} failed: ${response.status}`);
      return answered<VerdictView>(response);
    },
    // An agent's card is Keel's one read of it, whoever asks and from whichever page.
    findAgent: (agentId, signal) => createHttpSponsorship(options).findAgent(agentId, signal),
    // Keel decides who may answer: the person a question was put to first, and a maintainer of the project's
    // namespace (`sponsorOrMaintain`). The buttons are offered to a maintainer, and to whoever Keel lists the
    // question to; anyone else would be refused, and is offered none.
    canRule: (escalationId: string): boolean => maintainer || putToReader.has(escalationId),
    async readAsked(signal?: AbortSignal): Promise<void> {
      // A maintainer is offered every question of the project, and Keel lists none of it to someone it reads
      // only the project's public part: neither has anything to ask.
      if (project.viewer === undefined || maintainer) return;
      for (const item of await createHttpDirectory(options).listWaiting(signal))
        putToReader.add(item.id);
    },
    async giveRuling(command: RulingCommand): Promise<void> {
      // The operation's whole input, as Keel's contract has it: the question in the path, the key in the
      // header, and the ruling as the body.
      const {
        escalationId,
        "idempotency-key": key,
        ...ruling
      }: Operator_giveRulingInput = {
        escalationId: command.escalationId,
        "idempotency-key": command.idempotencyKey,
        option: command.option,
        ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
      };
      const response = await request(
        `${origin}/v1/escalations/${encodeURIComponent(escalationId)}/ruling`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(ruling),
        },
      );
      if (!response.ok) throw await refusalOf(response);
    },
    // Keel's memory of the project's decisions: its two reads, each with nothing of the page's added. The list
    // names the project, and one decision is asked for by its own id, which Keel reads to whoever reads the
    // project it was ruled in.
    decisions: {
      async listDecisions(asked, signal) {
        const input: Memory_listDecisionsInput = { project: project.id, ...asked };
        const response = await read(`/v1/decisions${queryOf({ ...input })}`, signal);
        if (!response.ok) throw await refusalOf(response);
        return answered<DecisionPage>(response);
      },
      async getDecision(decisionId, signal) {
        const input: Memory_getDecisionInput = { decisionId };
        const response = await read(
          `/v1/decisions/${encodeURIComponent(input.decisionId)}`,
          signal,
        );
        // Keel's one answer for a decision it never recorded and for one this reader is not read.
        if (response.status === 404) return null;
        if (!response.ok) throw await refusalOf(response);
        return answered<DecisionView>(response);
      },
    },
    // The agents invited to this one project: Keel's own three operations at the project's own address. Each
    // move carries a key made for the one attempt and nothing of the page's beside it.
    invited: {
      async listAgents(signal) {
        const input: Projects_listAgentsInput = { projectId: project.id };
        const response = await read(
          `/v1/projects/${encodeURIComponent(input.projectId)}/agents`,
          signal,
        );
        if (!response.ok) throw await refusalOf(response);
        return (await answered<ProjectAgents>(response)).items;
      },
      async inviteAgent(agent, scopes) {
        const {
          projectId,
          "idempotency-key": key,
          ...body
        }: Projects_inviteAgentInput = {
          projectId: project.id,
          "idempotency-key": `console:invite-agent:${crypto.randomUUID()}`,
          agent,
          scopes: [...scopes],
        };
        const response = await request(
          `${origin}/v1/projects/${encodeURIComponent(projectId)}/agents`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) throw await refusalOf(response);
        return answered<ProjectAgent>(response);
      },
      async removeAgent(agentId) {
        const {
          projectId,
          agentId: named,
          "idempotency-key": key,
        }: Projects_removeAgentInput = {
          projectId: project.id,
          agentId,
          "idempotency-key": `console:remove-agent:${crypto.randomUUID()}`,
        };
        const response = await request(
          `${origin}/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(named)}`,
          { method: "DELETE", headers: { "idempotency-key": key } },
        );
        if (!response.ok) throw await refusalOf(response);
        return answered<ProjectAgent>(response);
      },
    },
    // The credentials of the project's namespace, which a deploy target names one of.
    credentials: createHttpCredentials(options),
    // The project's deploy targets: Keel's own three operations at the project's own address. A target names
    // its credential by Keel's id for it, never by anything the token could be read from; its name and its
    // account are sent as typed less the space around them, which neither has.
    targets: {
      async listTargets(signal) {
        const input: Delivery_listDeployTargetsInput = { projectId: project.id };
        const response = await read(
          `/v1/projects/${encodeURIComponent(input.projectId)}/deploy-targets`,
          signal,
        );
        if (!response.ok) throw await refusalOf(response);
        return (await answered<DeployTargets>(response)).targets;
      },
      async putTarget(named, target) {
        const { projectId, name, ...body }: Delivery_putDeployTargetInput = {
          projectId: project.id,
          name: named.trim(),
          provider: target.provider,
          accountId: target.accountId.trim(),
          credential: target.credential,
        };
        const response = await request(
          `${origin}/v1/projects/${encodeURIComponent(projectId)}/deploy-targets/${encodeURIComponent(name)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) throw await refusalOf(response);
        return answered<DeployTargetView>(response);
      },
      async beginConnect(named) {
        const input: Delivery_beginCloudflareConnectInput = {
          projectId: project.id,
          name: named.trim(),
        };
        const response = await request(
          `${origin}/v1/projects/${encodeURIComponent(input.projectId)}/deploy-targets/${encodeURIComponent(input.name)}/cloudflare-connect`,
          { method: "POST" },
        );
        if (!response.ok) throw await refusalOf(response);
        return (await answered<CloudflareConnect>(response)).authorizeUrl;
      },
      async clearTarget(named) {
        const input: Delivery_deleteDeployTargetInput = { projectId: project.id, name: named };
        const response = await request(
          `${origin}/v1/projects/${encodeURIComponent(input.projectId)}/deploy-targets/${encodeURIComponent(input.name)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw await refusalOf(response);
      },
    },
    async getSettings(signal?: AbortSignal): Promise<ProjectSettings> {
      const response = await read(
        `/v1/projects/${encodeURIComponent(project.id)}/settings`,
        signal,
      );
      if (!response.ok) throw await refusalOf(response);
      return answered<ProjectSettings>(response);
    },
    async putSettings(settings: ProjectSettings): Promise<ProjectSettings> {
      // The operation's whole input: the project in the path, and every setting as the body. Keel replaces
      // them all, so none is left out.
      const { projectId, ...body }: Operator_putSettingsInput = {
        ...settings,
        projectId: project.id,
      };
      const response = await request(
        `${origin}/v1/projects/${encodeURIComponent(projectId)}/settings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw await refusalOf(response);
      return answered<ProjectSettings>(response);
    },
    async syncUpstream(): Promise<UpstreamSync> {
      // No body: Keel reads upstream from where the project was imported, and the reader from the session.
      const { projectId }: Operator_syncUpstreamInput = { projectId: project.id };
      const response = await request(
        `${origin}/v1/projects/${encodeURIComponent(projectId)}/sync`,
        {
          method: "POST",
        },
      );
      if (!response.ok) throw await refusalOf(response);
      return answered<UpstreamSync>(response);
    },
  };
}
