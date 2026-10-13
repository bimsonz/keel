// The console's three ports onto Keel. Views never import a transport: they
// read projections built from whatever implements these.
//
// KeelEventSource is pull-only and shaped like `GET /v1/events`: a page of the
// log from a cursor, optionally waiting for the tail. Virtual time, pacing and
// seeking live above it, so the mock needs no timers and the real stream needs
// no changes to the views.

import type { AnyEvent } from "../contract/events.ts";
import type * as Keel from "../contract/keel/index.ts";
import type { Observation } from "../contract/observations.ts";
import type { EvidenceLine } from "../contract/provisional.ts";

/** An opaque position in a log. */
export type Cursor = string;

export interface ReadRequest {
  /** Omit to read from the beginning. */
  cursor?: Cursor;
  /** At most this many items. The real endpoint allows up to 500. */
  limit?: number;
  /** Long-poll: wait up to this many seconds for something new. 0 reads history only. */
  waitSec?: number;
  signal?: AbortSignal;
}

export interface Page<Item> {
  items: readonly Item[];
  /** Where to read from next: the position just after the last item returned. Always present, as Keel's page has it. */
  nextCursor: Cursor;
}

/**
 * Keel's namespaces and projects, as it names them to whoever asks: its answers to `GET /v1/namespaces/{handle}`
 * and `GET /v1/namespaces/{handle}/projects/{name}`, and each entry of `GET /v1/projects`, in Keel's own models.
 * A reader with no session is named the public projects.
 */
export interface KeelDirectory {
  /**
   * Makes a project, as the person signed in: `POST /v1/projects`. Keel answers once the project's trunk exists,
   * and where it refuses a start it makes no project and gives the name back. `key` is the attempt's own: the
   * same request asked again under it finishes the same project.
   */
  createProject(asked: Keel.CreateProjectRequest, key: string): Promise<Keel.ProjectView>;
  /**
   * Whose a handle is: a person's, an agent's or an org's. Null where nobody has it. Keel answers anyone, so
   * that a handle exists is no secret; what it holds is.
   */
  findNamespace(handle: string, signal?: AbortSignal): Promise<Keel.NamespaceView | null>;
  /**
   * The project an address names, or null where Keel shows this reader none of that name. A private project
   * and one that is not there are the same answer, and the console tells neither apart.
   */
  findProject(
    namespace: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<Keel.ProjectView | null>;
  /** Every project Keel lists to this reader. */
  listProjects(signal?: AbortSignal): Promise<Keel.ProjectView[]>;
  /**
   * The open questions Keel lists to whoever is signed in, across every project it reads them, newest first:
   * one whose agent they sponsor, and one of a namespace they maintain once Keel puts it to its maintainers.
   * Keel refuses a reader with no session, so a visitor's page never asks.
   */
  listWaiting(signal?: AbortSignal): Promise<Keel.EscalationView[]>;
  /**
   * The next stretch of the reader's own feed, `GET /v1/events` with no project named: Keel's log across every
   * project it reads them. Only what kind each entry is, which is enough to know a question was put or closed.
   */
  readOwnFeed(asked: ReadRequest): Promise<Page<string>>;
}

export interface SourceDescriptor {
  /** `live` is Keel. `fixture` is a scripted log, which exists only in development and in tests. */
  mode: "fixture" | "live";
  scenario?: string;
  seed?: number;
  /**
   * The log's first instant, ISO 8601. Simulated time is measured from here. Absent where the log has not been
   * read yet: its first instant is then its first entry's.
   */
  epoch?: string;
  /** The one project this source reads, where Keel has said what it is. Its log holds that project's events alone. */
  project?: Keel.ProjectView;
}

export interface KeelEventSource {
  readonly descriptor: SourceDescriptor;
  readEvents(request?: ReadRequest): Promise<Page<AnyEvent>>;
  /** Timed facts that are not catalogue events. See contract/observations.ts. */
  readObservations(request?: ReadRequest): Promise<Page<Observation>>;
}

export interface ChangeDiff {
  changeId: string;
  commit: string;
  files: { path: string; before: string | null; after: string | null }[];
  /** Code tied to subjects: where a proposition is anchored. */
  anchors: {
    path: string;
    symbol?: string;
    line: number;
    side: "additions" | "deletions";
    subjectKey: string;
  }[];
}

/**
 * A verdict as Keel's read model gives it (`GET /v1/verdicts/{id}`): the event that issued it carries only
 * references to its evidence, and this carries the evidence itself.
 */
export interface VerdictReasons extends Omit<Keel.VerdictView, "reasons"> {
  reasons: EvidenceLine[];
}

/** Things the console fetches on demand rather than folds from the log. */
export interface KeelResources {
  getDiff(changeId: string, signal?: AbortSignal): Promise<ChangeDiff>;
  /** A probe's source, file by file, as its bundle holds it (`GET /v1/probes/{probeId}/source`). */
  getProbeSource(probeId: string, signal?: AbortSignal): Promise<Keel.ProbeSource>;
  getVerdict(verdictId: string, signal?: AbortSignal): Promise<VerdictReasons>;
  /** Every predicate's lattice, as Keel's domain has it (`GET /v1/lattices`). */
  getLattices(signal?: AbortSignal): Promise<Keel.LatticeSet>;
}

export interface RulingCommand {
  escalationId: string;
  /** The id of the option chosen. */
  option: string;
  rationale?: string;
  idempotencyKey: string;
}

/**
 * A project's settings as Keel holds them, and replacing them. Keel reads them to a member of the project's
 * namespace and lets a maintainer or an owner replace them; whoever else asks is given its refusal. Keel replaces
 * the settings whole, so what is sent is everything it answered with what the reader changed.
 */
export interface KeelSettings {
  getSettings(signal?: AbortSignal): Promise<Keel.ProjectSettings>;
  /** Answers with the settings as Keel then holds them. */
  putSettings(settings: Keel.ProjectSettings): Promise<Keel.ProjectSettings>;
}

/**
 * The agents a person has invited to one project of their own namespace, as a code host has a repository's
 * collaborators. Keel reads the project's owner the invitations not yet answered and what each gives; it reads
 * anyone else who reads the project the agents that have joined. An org's project takes none of its own: an
 * agent comes into an org. Keel takes an invitation or a removal from the owner alone, and only from a passkey
 * sign-in of the last ten minutes.
 */
export interface KeelProjectAgents {
  /** Keel's list for this reader, oldest invitation first: `GET /v1/projects/{projectId}/agents`. */
  listAgents(signal?: AbortSignal): Promise<Keel.ProjectAgent[]>;
  /** Invites the agent of that handle to read, or to read and work. Answers its row as it then stands. */
  inviteAgent(agent: string, scopes: readonly Keel.Scope[]): Promise<Keel.ProjectAgent>;
  /** Takes an agent off the project, or withdraws an invitation it has not answered. Answers the row, ended. */
  removeAgent(agentId: string): Promise<Keel.ProjectAgent>;
}

/** A project's source that has Keel's invitations to it: a test fixture's has none. */
export interface KeelInvited {
  invited: KeelProjectAgents;
}

/**
 * A project's decisions as Keel remembers them: what each ruling chose, and what it settled of the conflict it
 * ruled. Keel reads them to whoever reads the project, a visitor to a public one among them.
 */
export interface KeelDecisions {
  /**
   * A page of the project's decisions, newest first, or of the ones on one subject: `GET /v1/decisions`. The
   * page after it is asked for with the cursor Keel gave, and the last page names none.
   */
  listDecisions(
    asked: { subject?: string; cursor?: string },
    signal?: AbortSignal,
  ): Promise<Keel.DecisionPage>;
  /**
   * One decision by Keel's id for it: `GET /v1/decisions/{decisionId}`. Null where Keel reads this reader none
   * by that id: one it never recorded and one of a project the reader is not read are the same answer.
   */
  getDecision(decisionId: string, signal?: AbortSignal): Promise<Keel.DecisionView | null>;
}

/** A project's source that has Keel's memory of its decisions: a test fixture's has none. */
export interface KeelRemembered {
  decisions: KeelDecisions;
}

/**
 * What the console may change in a project's log, so it is its own port. Keel decides who may: the reader's own session
 * is all the console sends. A ruling is never applied optimistically: its effect arrives through the log.
 */
export interface KeelCommands {
  giveRuling(command: RulingCommand): Promise<void>;
  /** Whether to offer this reader the ruling's buttons. Absent: the source decides some other way. */
  canRule?(escalationId: string): boolean;
  /**
   * Asks Keel which open questions it lists to this reader, where `canRule` waits on that: Keel takes a ruling
   * from the person a question was put to first, whatever their role. Absent where nothing is to be asked.
   */
  readAsked?(signal?: AbortSignal): Promise<void>;
}

/** Keel's public card of an agent, which it reads anyone by the agent's id: never who stands behind it. */
export interface KeelAgents {
  /** Null where Keel knows no agent by that id. */
  findAgent(agentId: string, signal?: AbortSignal): Promise<Keel.AgentCard | null>;
  /**
   * The card of the agent whose handle this is. An agent's handle is its own namespace, so Keel is asked whose
   * the handle is, and then for that agent's card. Null where the handle is nobody's, or is not an agent's.
   */
  findAgentAt?(handle: string, signal?: AbortSignal): Promise<Keel.AgentCard | null>;
}

/** Keel refused something, and said why. `next` is the ways forward it gave, each by its title. */
/**
 * Standing behind an agent: Keel's public card of one, and a person's approval of the code it showed them.
 * The approval is the signed-in person's, and Keel takes it only from a passkey sign-in of the last ten minutes.
 */
export interface KeelSponsorship extends KeelAgents {
  /** Stands behind the agent with the code it showed. The code rides in the body of this one call, and nowhere else. */
  approve(agentId: string, code: string): Promise<void>;
  /** The agents Keel names the reader the sponsor of, oldest first: `GET /v1/agents/sponsored`. */
  listSponsored(signal?: AbortSignal): Promise<Keel.AgentProfile[]>;
  /** Pauses an agent, with the reason Keel keeps. Each of these three answers the agent as it then stands. */
  pause(agentId: string, reason: string): Promise<Keel.AgentProfile>;
  /** Lets a paused agent work again. */
  unpause(agentId: string): Promise<Keel.AgentProfile>;
  /** Ends the link: the reader no longer stands behind the agent. */
  end(agentId: string): Promise<Keel.AgentProfile>;
}

/**
 * The agents in an org. Keel reads anyone the agents that have joined it; it reads a member the invitations not
 * yet answered too, with what each gives and who made it. A member invites an agent by its handle and answers
 * for it there, and Keel takes an invitation or a removal only from a passkey sign-in of the last ten minutes.
 */
export interface KeelOrgAgents {
  /** Keel's list for this reader, oldest invitation first: `GET /v1/namespaces/{handle}/agents`. */
  listAgents(org: string, signal?: AbortSignal): Promise<Keel.NamespaceAgent[]>;
  /** Invites the agent of that handle to read, or to read and work. Answers its row as it then stands. */
  inviteAgent(
    org: string,
    agent: string,
    scopes: readonly Keel.Scope[],
  ): Promise<Keel.NamespaceAgent>;
  /** Takes an agent out of the org, or withdraws an invitation it has not answered. Answers the row, ended. */
  removeAgent(org: string, agentId: string): Promise<Keel.NamespaceAgent>;
}

export class KeelRefused extends Error {
  readonly code: string;
  readonly status: number;
  readonly next: readonly string[];
  constructor(said: string, code: string, status: number, next: readonly string[] = []) {
    super(said);
    this.name = "KeelRefused";
    this.code = code;
    this.status = status;
    this.next = next;
  }
}
