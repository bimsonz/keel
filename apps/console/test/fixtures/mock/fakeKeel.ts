// A stand-in for Keel's API, for tests. It serves scenario 1's one project the
// way Keel does: a reader is whoever the session cookie says, or a visitor;
// whose a handle is, it answers anyone; a project is found by its namespace's
// handle and its name; its events are read by cursor with the cursor always
// given, a verdict's evidence by its id, and a member of the project's
// namespace may answer its question, once. A member reads the project's
// settings, and a maintainer or an owner replaces them, which is how the
// project is made public or private. What a reader may not see is answered as
// what is not there. Its answers are typed by Keel's own generated
// wire types, but for the project, whose shape is the console's read of it
// the read (source/types.ts). An event's payload it serves as
// Keel's design settles it (contract/events.ts, `Ahead`). Nothing in the
// built console imports this.

import type { AnyEvent } from "../../../src/contract/events.ts";
import type {
  AgentCard,
  AgentProfile,
  Credential,
  Credentials,
  DecisionPage,
  DecisionView,
  EscalationPage,
  EscalationView,
  EventPage,
  EventProposition,
  EventRecord,
  DeployTargetView,
  DeployTargets,
  LatticeSet,
  NamespaceAgent,
  NamespaceAgents,
  NamespaceRef,
  NamespaceView,
  NextAction,
  ProjectAgents,
  ProbeSource,
  ProjectSettings,
  ProjectView,
  SponsorRequest,
  SponsoredAgents,
  RepoBlob,
  RepoCommitDiff,
  RepoCommitPage,
  RepoTree,
  VerdictView,
} from "../../../src/contract/keel/index.ts";
import { RepoRefused } from "../../../src/source/repository.ts";
import { LATTICES } from "../lattices.ts";
import { createMockRepository } from "./repository.ts";
import { type S1Ruling, S1_CHOICES, generateS1 } from "./s1.ts";
import { generateS2 } from "./s2.ts";

/**
 * Keel records no cost yet (QUESTIONS B4), so this stand-in publishes none: what a fixture prices is the
 * fixture's own, and a console that showed a cost here would be showing one Keel never gave.
 */
function unpriced(payload: AnyEvent["payload"]): AnyEvent["payload"] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any payload may carry the fixture's additions
  const added = (payload as { x?: { cost?: unknown } }).x;
  if (added?.cost === undefined) return payload;
  const { cost: _cost, ...rest } = added;
  const { x: _x, ...own } = payload as { x?: unknown };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same payload, less its price
  return (Object.keys(rest).length === 0 ? own : { ...own, x: rest }) as AnyEvent["payload"];
}

/**
 * Keel's event for a verdict carries its outcome, whether a plan ran and the evidence it recorded, and no
 * sentence of its own: a fixture's summary is the fixture's, and is left out where the stand-in answers as Keel
 * does.
 */
function unsummarised(payload: AnyEvent["payload"]): AnyEvent["payload"] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any payload may carry the fixture's additions
  const added = (payload as { x?: { summary?: unknown } }).x;
  if (added?.summary === undefined) return payload;
  const { summary: _summary, ...rest } = added;
  const { x: _x, ...own } = payload as { x?: unknown };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same payload, less the fixture's sentence
  return (Object.keys(rest).length === 0 ? own : { ...own, x: rest }) as AnyEvent["payload"];
}

export type Role = NonNullable<ProjectView["viewer"]>["role"];

/**
 * Who a request is from, as Keel's gate reads it: a user, by their session, with the role they have in the
 * project's namespace where they are a member of it; or null, a visitor. `sponsor` says they are the person the
 * question's agent names: the one Keel asks first.
 */
export type Reader = { role?: Role; sponsor?: boolean; id?: string; fresh?: boolean } | null;

/**
 * What Cloudflare answers Keel's check of a deploy target: the token reaches the account's Workers, with the
 * account's workers.dev subdomain where it has one; or it does not, and why, with Cloudflare's code where it gave
 * one. Keel's `deploy-target.ts` asks it after the credential is found and before the cap is counted.
 */
export type Reached =
  | { reaches: true; subdomain?: string }
  | { reaches: false; why: "token-invalid" | "account-unreachable"; code?: number };

/** A deploy target's name and a credential's label, as Keel's contract has them. */
const TARGET_NAME = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;
const CREDENTIAL_LABEL = /^\S(?:.*\S)?$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** The most deploy targets Keel lets a project hold. */
export const TARGETS_MOST = 16;

/**
 * How long a question waits for the person asked first before Keel lists it to its namespace's maintainers
 * too: `MAINTAINERS_AFTER_MS` in Keel's core, `escalation-views.ts`. Written beside Keel's and not imported.
 */
export const MAINTAINERS_AFTER_MS = 30 * 60 * 1000;

/**
 * The events Keel reads to a project's members and to nobody else, as its read scope has them
 * (`EVENT_AUDIENCE` in Keel's core, `read-scope.ts`): operator data (an agent's enrolment and standing, a
 * project's settings and deploy targets), the questions put to a person and their rulings, an agent's
 * sessions, and what happens to users and orgs. It is written beside Keel's and not imported, so when that
 * table changes this is brought level with it. Everything else a public project's log holds is anyone's.
 */
export const MEMBERS_ONLY: ReadonlySet<string> = new Set([
  "AgentInvited",
  "AgentLeftNamespace",
  "AgentInvitedToProject",
  "AgentLeftProject",
  "AgentEnrolled",
  "AgentSuspended",
  "AgentReinstated",
  "AgentRevoked",
  "AgentSponsored",
  "AgentUnsponsored",
  "UserSignedUp",
  "OrgCreated",
  "MembershipChanged",
  "UserSuspended",
  "UserReinstated",
  "OrgSuspended",
  "OrgReinstated",
  "OrgDeleted",
  "ProjectDeleted",
  "ProjectSettingsChanged",
  "EscalationRaised",
  "EscalationWithdrawn",
  "EscalationWidened",
  "RulingGiven",
  "OverruleRequested",
  "SessionOpened",
  "MessagesCaptured",
  "SessionRedacted",
  "CredentialStored",
  "CredentialRemoved",
  "DeployTargetSet",
  "DeployTargetCleared",
]);

/** The cookie Keel keeps a session in. */
export const SESSION_COOKIE = "__Secure-keel.session_token";

export interface Call {
  method: string;
  /** The host the request was addressed to. */
  host: string;
  path: string;
  query: string;
  /** What the request carried as a credential of the sender's own making. The console's page sends none. */
  authorization: string;
  idempotencyKey: string;
  body: string;
}

export interface FakeKeel {
  fetch(request: Request): Promise<Response>;
  /** Every request it has been sent, in order. */
  calls: Call[];
  /** The log as it stands. */
  events(): readonly AnyEvent[];
  /** The project it holds, as it names it to a reader who is not a member of its namespace. */
  project: ProjectView;
  /** An agent asks for a sponsor, as Keel's `askSponsor` answers it: a code good once and for ten minutes. */
  askSponsor(agentId: string): SponsorRequest;
  /** Who stands behind an agent, by the id its reader was known by; nobody, where it has no sponsor. */
  sponsorOf(agentId: string): string | undefined;
  /** How an agent stands: `suspended` while its sponsor has it paused. */
  standingOf(agentId: string): NonNullable<AgentProfile["state"]>;
  /** The reason an agent's pause was given, while it is paused. */
  pausedFor(agentId: string): string | undefined;
  /**
   * An agent accepts the invitation it has into an org, as its own call to Keel does: a test's way to an agent
   * that has joined. The agent's own three calls are no page's.
   */
  accepts(org: string, agentId: string): void;
  /** An agent accepts the invitation it has to one project, as its own call to Keel does. */
  joins(projectId: string, agentId: string): void;
}

/** An agent's place in an org, as Keel keeps it while its invitation stands: an ended one is in no list. */
interface Invited {
  agentId: string;
  /** The account of the member who invited it. */
  by: string;
  scopes: NonNullable<NamespaceAgent["scopes"]>;
  state: "invited" | "joined";
  invitedAt: string;
  joinedAt?: string;
}

/** A handle, as Keel's contract has one, and the header every move carries: its validators refuse any other. */
const AGENT_HANDLE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;
const keyed128 = (key: string): boolean => key.length >= 8 && key.length <= 128;

/** Keel's refusal of someone who may not make a move in an org, with who to ask: `lacksRole`. */
const lacksIn = (role: string): Response =>
  problem(
    403,
    "auth.forbidden",
    [{ kind: "escalate", title: `Ask ${role}: this needs that role` }],
    "Refused: role.",
  );

/** Keel's way forward from a refused start: the same operation, asked again. */
const again = (title: string): NextAction => ({
  kind: "call",
  title,
  operationId: "Operator_createProject",
});

/** The one public repository the stand-in can import: every other address is told as nothing there. */
/** Keel's id for a project, as its contract has it: what a fork names its source by. */
const PROJECT_ID = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

export const PUBLIC_REPOSITORY = "https://git.example/acme/forge-lite";

/** How long an agent's code is good for. */
export const SPONSOR_CODE_FOR_MS = 600_000;

const RULINGS: ReadonlySet<string> = new Set(S1_CHOICES.map((option) => option.id));

/** Keel's problem body, as its API document has it (the generated wire types cover inputs and answers, not refusals). */
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId: string;
  nextActions: NextAction[];
}

function isRuling(option: string): option is S1Ruling {
  return RULINGS.has(option);
}

function fields(text: string): Map<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  return new Map<string, unknown>(
    typeof parsed === "object" && parsed !== null ? Object.entries(parsed) : [],
  );
}

function problem(
  status: number,
  code: string,
  nextActions: NextAction[] = [],
  detail?: string,
): Response {
  const body: ProblemDetails = {
    type: `https://keel.town/problems/${code}`,
    title: code,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    requestId: "req_test",
    nextActions,
  };
  return Response.json(body, { status, headers: { "content-type": "application/problem+json" } });
}

/** Keel's answer to a session that was not signed in by a passkey in the last ten minutes: `freshSignInRequired`. */
const staleSignIn = (): Response =>
  problem(
    403,
    "auth.fresh_sign_in_required",
    [{ kind: "escalate", title: "Sign in again with your passkey, then retry" }],
    "This needs a fresh sign-in: a passkey sign-in from the last ten minutes.",
  );

/**
 * Keel's one answer to an approval that finds no live request, `noSuchRequest`: the code is wrong, used or run
 * out, or there is no such agent, and nothing in it says which.
 */
const noSuchRequest = (): Response =>
  problem(
    404,
    "resource.not_found",
    [{ kind: "escalate", title: "Ask the agent for a new link, and approve with it" }],
    "No agent is asking for a sponsor with that code: it is mistyped, already used or has run out. Ask the agent for a new link, and approve with that one.",
  );

/**
 * What Keel says to an agent that asks for a sponsor while it has one (`stateRefused`, `sponsor-held`). Keel
 * tells the agent itself, with the end of its link as the way forward, and gives it no code. So no approval ever
 * meets it: a person who approves an agent somebody stands behind holds a code that is spent, and reads the one
 * answer of a code that is no good. That is the sponsor's own second approval too.
 */
export const SPONSOR_HELD = "already has a sponsor, and an agent has one.";

/** Keel's refusal of someone who lacks a role, with the way forward it gives: `authorize.ts`, `lacksRole`. */
const lacks = (role: string): Response =>
  problem(403, "auth.forbidden", [
    { kind: "escalate", title: `Ask ${role}: this needs that role` },
  ]);

/** Keel's sentence for a question that is not there, or is one of a project this reader is not shown. */
const noQuestion = (id: string): Response =>
  problem(
    404,
    "escalation.not_found",
    [
      {
        kind: "read",
        title: "List the questions waiting for you",
        operationId: "Operator_listEscalations",
      },
    ],
    `No escalation ${id}.`,
  );

/** A namespace's id and kind: its account's, as Keel answers them beside the handle that was asked for. */
export type Whose = Pick<NamespaceView, "id" | "kind">;

/** The id the project's own namespace is answered under where no identity is asked: one of its kind's shape. */
const FIXTURE_IDS: Record<NamespaceView["kind"], string> = {
  user: "usr_0000000000000000000000ACME",
  agent: "agt_0000000000000000000000ACME",
  org: "org_0000000000000000000000ACME",
};

/**
 * The propositions a ruling upheld, as Keel's `holds` reads them off the conflict's two sides and whom the
 * ruling went against: against the change that makes the effect, the premise stood; against the change that
 * holds the premise, the effect did; against neither or both, or where a side is not named, nothing.
 */
function upheldOf(
  sides: Extract<AnyEvent, { type: "ConflictSuspected" }>["payload"],
  against: readonly string[],
): EventProposition[] {
  const { premise, effect } = sides;
  if (premise === undefined || effect === undefined) return [];
  const holderLost = against.includes(premise.holder);
  const authorLost = against.includes(effect.changeId);
  if (holderLost === authorLost) return [];
  return [authorLost ? premise.proposition : effect.proposition];
}

export function createFakeKeel(
  options: {
    seed?: number;
    pageSize?: number;
    /** How many decisions a page of Keel's list holds where the reader names no limit: Keel's fifty, unless a test says. */
    decisionPage?: number;
    /**
     * Which scripted log is the project's: scenario 1's, which ends at its question, unless a test says
     * scenario 2's, which opens nine days after that question was ruled and bounces a change on the guard.
     */
    story?: "s1" | "s2";
    /** The namespace the project is in: an org called `acme`, unless a test says whose. */
    namespace?: NamespaceRef;
    /**
     * Whose a handle is and the id of its account, for a test that has an identity to ask. Left out, the project's
     * own namespace is the only one, under an id of the fixture's.
     */
    whose?: (handle: string) => Whose | undefined | Promise<Whose | undefined>;
    /** Who may read the project with no session. Keel creates a project private. */
    visibility?: "public" | "private";
    /** Sessions, by the value of their cookie: the role each one's user has in the project's namespace, or none. */
    sessions?: Record<string, Role | "stranger">;
    /** Says who a request is from, in place of `sessions`: for a test that has real sessions to ask about. */
    readerOf?: (request: Request) => Reader | Promise<Reader>;
    /**
     * `false` answers of a verdict as Keel does today: it serves no view of one (a read of it is not found),
     * and its event has no sentence of its own. Left out, a verdict's view is served and the fixture's
     * sentence rides on its event, which is how the fixtures' own pages are drawn.
     */
    verdictViews?: boolean;
    /**
     * The role an account has in an org, by the account's id and the org's handle, for a test that has an
     * identity to ask. Where it names none, a reader's role in the project's own namespace is what `sessions`
     * or `readerOf` gave them, and they are no member of any other.
     */
    roleIn?: (userId: string, org: string) => Role | undefined | Promise<Role | undefined>;
    /** The agents Keel knows by id beside the ones its log enrols, each as anyone may see it. */
    agents?: readonly AgentCard[];
    /**
     * The agents of the log that signed themselves up, by the name the log has, each with its handle: Keel's card
     * of one has its handle, its namespace is its own, and no project's log holds an enrolment of it.
     */
    signedUp?: Record<string, string>;
    /** The sessions, by their cookie's value, signed in by a passkey in the last ten minutes. Every other is stale. */
    freshly?: readonly string[];
    /**
     * The session, by its cookie's value, of the person the question's agent names: Keel asks them first, and
     * its namespace's maintainers once `MAINTAINERS_AFTER_MS` has passed. Left out, with `sponsored` unset, the
     * question names nobody and is its maintainers' at once.
     */
    sponsor?: string;
    /** That the question names a sponsor, where `readerOf` says who each reader is. */
    sponsored?: boolean;
    /** Keel's clock, for what it lists to whom and when. The wall clock unless a test says otherwise. */
    now?: () => number;
    /**
     * What Cloudflare answers for a token and an account. Left out, every token reaches every account, and the
     * account's subdomain is `keel-previews`.
     */
    cloudflare?: (asked: { secret: string; accountId: string }) => Reached;
    /**
     * How many entries of other projects the instance's log holds ahead of this project's first. Keel's log is
     * the whole instance's: a page is its next stretch with the project's entries picked out, so a stretch
     * that holds none is an empty page whose cursor has moved on.
     */
    ahead?: number;
  } = {},
): FakeKeel {
  const seed = options.seed ?? 42;
  const pageSize = options.pageSize ?? 500;
  const decisionPage = options.decisionPage ?? 50;
  const ahead = options.ahead ?? 0;
  let log = options.story === "s2" ? generateS2(seed) : generateS1(seed);
  const repository = createMockRepository(() => log);
  /** Every event of one kind the log holds, in its order. */
  const of = <Type extends AnyEvent["type"]>(type: Type) =>
    log.events.filter((event): event is Extract<AnyEvent, { type: Type }> => event.type === type);
  // The question the story holds at; or, where history has answered it, the one history asked.
  const escalationId =
    log.gates[0]?.escalationId ?? of("EscalationRaised")[0]?.payload.escalationId ?? "";
  const [given] = of("RulingGiven");
  let ruled: { option: string; key: string } | undefined =
    given === undefined ? undefined : { option: given.payload.option, key: "" };
  let waiters: (() => void)[] = [];
  const calls: Call[] = [];
  const created = log.events.find((event) => event.type === "ProjectCreated");
  if (created === undefined) throw new Error("scenario 1 creates no project");
  const project: ProjectView = {
    id: created.payload.projectId,
    namespace: options.namespace ?? { handle: "acme", kind: "org" },
    name: created.payload.name,
    visibility: options.visibility ?? "private",
    createdAt: created.at,
  };
  /** What Keel holds for the project beside who may read it, which is the project's own `visibility`. */
  let kept: Omit<ProjectSettings, "visibility"> = {
    protectedPaths: ["infra/**"],
    maxBatchSize: 8,
    verification: "required",
  };
  const settings = (): ProjectSettings => ({ ...kept, visibility: project.visibility });

  /**
   * Keel's index of the project's decisions, as `decision-index.ts` joins it when it is read: each decision as
   * its own events leave it, with what its conflict says of it. The subject, whom the ruling went against, what
   * it upheld and the guard that holds it are the conflict's; until the conflict's resolution names the
   * decision, the ruling has upheld nothing. Newest first. Written beside Keel's, and not imported.
   */
  const remembered = (): DecisionView[] =>
    of("DecisionRecorded")
      .map((recorded): DecisionView => {
        const { decisionId, escalationId: answered, option, summary, scope } = recorded.payload;
        const ended = [...of("DecisionSuperseded"), ...of("DecisionOverruled")].find(
          (event) => event.payload.decisionId === decisionId,
        );
        // The conflict the ruling was about is the one its question was put about.
        const about = of("EscalationRaised").find(
          (event) => event.payload.escalationId === answered,
        )?.payload.about;
        const conflictId = about?.kind === "conflict" ? about.id : undefined;
        const sides = of("ConflictSuspected").find(
          (event) => event.payload.conflictId === conflictId,
        )?.payload;
        const resolved = of("ConflictResolved").find(
          (event) =>
            event.payload.conflictId === conflictId && event.payload.decisionId === decisionId,
        )?.payload;
        const guard = of("GuardAdmitted").find((event) => event.payload.conflictId === conflictId)
          ?.payload.guardId;
        const retired = of("GuardRetired").some((event) => event.payload.guardId === guard);
        const upheld =
          resolved === undefined || sides === undefined
            ? []
            : upheldOf(sides, resolved.against ?? []);
        // A guard is drawn from the premise, so a ruling for the effect leaves its guard holding nothing.
        const asserted = JSON.stringify(sides?.premise?.proposition);
        const standing =
          guard !== undefined &&
          !retired &&
          upheld.some((proposition) => JSON.stringify(proposition) === asserted);
        return {
          id: decisionId,
          label: recorded.label ?? "D-0",
          option,
          summary,
          ...(scope === undefined ? {} : { scope }),
          decidedAt: recorded.at,
          state:
            ended === undefined
              ? "active"
              : ended.type === "DecisionSuperseded"
                ? "superseded"
                : "overruled",
          escalationId: answered,
          project: project.id,
          ...(conflictId === undefined ? {} : { conflictId }),
          ...(sides?.subjectKey === undefined ? {} : { subject: sides.subjectKey }),
          holds: upheld,
          ...(resolved?.against === undefined ? {} : { against: [...resolved.against] }),
          guards: standing ? [guard] : [],
        };
      })
      .toSorted(
        (a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt) || b.id.localeCompare(a.id),
      );

  /** The question as the log raised it: Keel's view of an escalation is that event's own fields. */
  const raised = () => log.events.find((event) => event.type === "EscalationRaised");
  const readerOf =
    options.readerOf ??
    ((request: Request): Reader => {
      const held = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(
        request.headers.get("cookie") ?? "",
      )?.[1];
      const role = held === undefined ? undefined : options.sessions?.[held];
      if (role === undefined) return null;
      const known = {
        id: held ?? "",
        fresh: options.freshly?.includes(held ?? "") === true,
        ...(held === options.sponsor ? { sponsor: true } : {}),
      };
      return role === "stranger" ? known : { role, ...known };
    });
  const sponsored = options.sponsor !== undefined || options.sponsored === true;
  const now = options.now ?? Date.now;
  /** The question as Keel's list and its ruling both answer it: its label, its project's place, where it stands. */
  const viewOf = (asked: NonNullable<ReturnType<typeof raised>>): EscalationView => ({
    id: asked.payload.escalationId,
    label: asked.label ?? "E-1",
    project: { id: project.id, namespace: project.namespace.handle, name: project.name },
    question: asked.payload.question,
    options: asked.payload.options,
    about: asked.payload.about,
    category: asked.payload.category,
    evidence: asked.payload.evidence,
    precedents: asked.payload.precedents,
    default: asked.payload.default,
    raisedAt: asked.at,
    state: ruled === undefined ? "open" : "ruled",
  });

  /**
   * Keel's card of each agent that works in the project, as it reads anyone. One a member enrolled has the kind
   * it was enrolled as and the namespace it works in. One that signed itself up has its handle and neither of
   * those, and no project's log holds an enrolment of it: `keyed` is those agents, by id.
   */
  const keyed = new Map<string, string>();
  const working = log.events.flatMap((event): AgentCard[] => {
    if (event.type !== "AgentEnrolled" || event.payload.kind === "human") return [];
    const { agentId: id, name, kind } = event.payload;
    const handle = options.signedUp?.[name];
    if (handle === undefined) return [{ id, name, kind, namespace: project.namespace.handle }];
    keyed.set(id, handle);
    return [{ id, name, handle }];
  });
  const agents = new Map([...working, ...(options.agents ?? [])].map((agent) => [agent.id, agent]));
  /**
   * The agents with a place in each org, by the org's handle and then by the agent's id, oldest invitation
   * first; and what each move's key was used for, so the same request asked again is answered as it was.
   */
  const invited = new Map<string, Map<string, Invited>>();
  const moves = new Map<string, string>();
  const ended = new Map<string, NamespaceAgent>();
  /** The agents a person has invited to one project of theirs, by the project's id and then by the agent's. */
  const invitedTo = new Map<string, Map<string, Invited>>();
  // An agent's place as Keel reads it: who it is, where its invitation stands, and to whoever the place is
  // (an org's members, a project's owner) what the invitation gives, who made it and when.
  const rowOf = (
    row: Invited,
    members: boolean,
    state: NamespaceAgent["state"] = row.state,
  ): NamespaceAgent => {
    const whom = agents.get(row.agentId);
    return {
      id: row.agentId,
      name: whom?.name ?? row.agentId,
      ...(whom?.handle === undefined ? {} : { handle: whom.handle }),
      ...(whom?.kind === undefined ? {} : { kind: whom.kind }),
      state,
      ...(members ? { scopes: [...row.scopes], invitedBy: row.by, invitedAt: row.invitedAt } : {}),
      ...(row.joinedAt === undefined ? {} : { joinedAt: row.joinedAt }),
    };
  };
  /**
   * The projects made here, by the key each was made under, with what was asked: Keel's `createProject`. A
   * made project is its maker's to read, and holds a trunk and no entry yet.
   */
  /** Each project made here, under the key it was asked with. `from` is the project a fork was taken from, by its id. */
  const made = new Map<string, { asked: string; by: string; view: ProjectView; from?: string }>();
  const madeAt = (handle: string, name: string) =>
    [...made.values()].find(
      (one) => one.view.namespace.handle === handle && one.view.name === name.toLowerCase(),
    );
  /**
   * Each namespace's credentials by its handle, oldest first, with the token Keel seals: the stand-in keeps it
   * only to say, as Cloudflare would, whether it reaches an account. Nothing it answers holds it.
   */
  const stored = new Map<string, { credential: Credential; secret: string }[]>();
  /** Each project's deploy targets, by its id and then by name. */
  const targeted = new Map<string, Map<string, DeployTargetView>>();
  const cloudflare =
    options.cloudflare ?? ((): Reached => ({ reaches: true, subdomain: "keel-previews" }));
  /** Each agent's live request for a sponsor, and who stands behind each: the link, as Keel's handler keeps it. */
  const asks = new Map<string, { code: string; until: number }>();
  const behind = new Map<string, string>();
  /** How each agent stands, where it is not active, and the reason its pause was given. */
  const standing = new Map<string, NonNullable<AgentProfile["state"]>>();
  const pauses = new Map<string, string>();
  /** An agent as Keel answers its sponsor: its `agentProfile`. */
  const profileOf = (known: AgentCard): AgentProfile => ({
    id: known.id,
    projectId: project.id,
    name: known.name,
    kind: known.kind,
    scopes: [],
    ...(behind.has(known.id) ? { sponsor: behind.get(known.id) ?? "" } : {}),
    revocationEpoch: 0,
    state: standing.get(known.id) ?? "active",
    createdAt: created.at,
  });

  return {
    calls,
    events: () => log.events,
    project,
    askSponsor(agentId) {
      // Keel refuses the ask of an agent that has a sponsor, and tells the agent. A new request replaces the last.
      if (behind.has(agentId)) throw new Error(`${agentId} ${SPONSOR_HELD}`);
      const code = `spn_${crypto.randomUUID().replaceAll("-", "")}`;
      const until = now() + SPONSOR_CODE_FOR_MS;
      asks.set(agentId, { code, until });
      return {
        code,
        url: `https://keel.test/sponsor#agent=${encodeURIComponent(agentId)}&code=${encodeURIComponent(code)}`,
        expiresAt: new Date(until).toISOString(),
      };
    },
    sponsorOf: (agentId) => behind.get(agentId),
    standingOf: (agentId) => standing.get(agentId) ?? "active",
    pausedFor: (agentId) => pauses.get(agentId),
    accepts(org, agentId) {
      const row = invited.get(org.toLowerCase())?.get(agentId);
      if (row === undefined || row.state !== "invited")
        throw new Error(`${agentId} has no invitation into ${org} to accept`);
      row.state = "joined";
      row.joinedAt = new Date(now()).toISOString();
    },
    joins(projectId, agentId) {
      const row = invitedTo.get(projectId)?.get(agentId);
      if (row === undefined || row.state !== "invited")
        throw new Error(`${agentId} has no invitation to ${projectId} to accept`);
      row.state = "joined";
      row.joinedAt = new Date(now()).toISOString();
    },
    async fetch(request) {
      const url = new URL(request.url);
      const sent = request.method === "GET" ? "" : await request.text();
      calls.push({
        method: request.method,
        host: url.host,
        path: url.pathname,
        query: url.search.slice(1),
        authorization: request.headers.get("authorization") ?? "",
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        body: sent,
      });

      const reader = await readerOf(request);
      const member = reader?.role !== undefined;
      /** The project is shown to its namespace's members, and to anyone where it is public. To the rest it is not there. */
      const visible = member || project.visibility === "public";
      const gone = (): Response => problem(404, "resource.not_found");
      // A fork names its source to a reader who is read that source, and to no other, as Keel's `sourceOf`
      // does on the answer to its making and on a read of the one project. A list names none.
      const shown = (one: { view: ProjectView; from?: string }): ProjectView => {
        const source =
          one.from === project.id
            ? visible
              ? project
              : undefined
            : [...made.values()].find(
                (other) => other.view.id === one.from && other.by === reader?.id,
              )?.view;
        return source === undefined
          ? one.view
          : {
              ...one.view,
              forkedFrom: { id: source.id, namespace: source.namespace.handle, name: source.name },
            };
      };

      // The agents a person stands behind, Keel lists to that person and to nobody else: `listSponsored`.
      if (url.pathname === "/v1/agents/sponsored" && request.method === "GET") {
        if (reader === null) return problem(401, "auth.required");
        return Response.json({
          items: [...agents.values()]
            .filter((agent) => reader.id !== undefined && behind.get(agent.id) === reader.id)
            .map(profileOf),
        } satisfies SponsoredAgents);
      }

      // Who an agent is, Keel answers anyone: its card, and never who stands behind it. The card names the orgs
      // the agent has joined, each by its handle and oldest invitation first, and has no list where it has joined
      // none: an invitation nobody has answered is in none, and who made any of them is never read (Keel's
      // `joinedOrgs`).
      const card = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
      if (card !== null && request.method === "GET") {
        const known = agents.get(decodeURIComponent(card[1] ?? ""));
        if (known === undefined) return gone();
        const orgs = [...invited]
          .flatMap(([handle, rows]) => {
            const row = rows.get(known.id);
            return row?.state === "joined"
              ? [{ handle, kind: "org" as const, at: row.invitedAt }]
              : [];
          })
          .toSorted((a, b) => a.at.localeCompare(b.at))
          .map(({ handle, kind }) => ({ handle, kind }));
        return Response.json({
          ...known,
          ...(orgs.length === 0 ? {} : { orgs }),
        } satisfies AgentCard);
      }

      // A person stands behind an agent with the code it showed them: Keel's `approveSponsor`.
      const link = /^\/v1\/agents\/([^/]+)\/sponsor$/.exec(url.pathname);
      if (link !== null && request.method === "PUT") {
        if (reader === null) return problem(401, "auth.required");
        // Only a passkey sign-in of the last ten minutes approves.
        if (reader.fresh !== true) return staleSignIn();
        const agentId = decodeURIComponent(link[1] ?? "");
        const known = agents.get(agentId);
        const asked = asks.get(agentId);
        // A code that is wrong, used or run out, and an agent that is not there, are one answer, and it comes
        // before anything the agent's own standing would say: a code that is no good learns nothing of an agent.
        if (
          known === undefined ||
          asked === undefined ||
          asked.code !== fields(sent).get("code") ||
          now() > asked.until
        )
          return noSuchRequest();
        asks.delete(agentId);
        behind.set(agentId, reader.id ?? "");
        return Response.json(profileOf(known));
      }

      // A sponsor's moves on an agent: pause it, unpause it, end the link. Keel's policy answers first, and to
      // anyone but the sponsor the agent is not there; then the fresh sign-in; then whether the agent, as it
      // stands, allows the move (`standingError`). Ending the link reinstates a paused agent.
      const stood = /^\/v1\/agents\/([^/]+)\/(suspend|reinstate)$/.exec(url.pathname);
      const ending = link !== null && request.method === "DELETE";
      if ((stood !== null && request.method === "POST") || ending) {
        if (reader === null) return problem(401, "auth.required");
        const agentId = decodeURIComponent((stood ?? link)?.[1] ?? "");
        const command = ending ? "Unsponsor" : stood?.[2] === "suspend" ? "Suspend" : "Reinstate";
        const reason = fields(sent).get("reason");
        if (command === "Suspend" && typeof reason !== "string")
          return problem(400, "request.invalid");
        const known = agents.get(agentId);
        if (known === undefined || reader.id === undefined || behind.get(agentId) !== reader.id)
          return gone();
        if (reader.fresh !== true) return staleSignIn();
        const stands = standing.get(agentId) ?? "active";
        if (
          (command === "Suspend" && stands !== "active") ||
          (command === "Reinstate" && stands !== "suspended")
        )
          return problem(
            409,
            "agent.state_refused",
            stands === "suspended"
              ? [
                  {
                    kind: "call",
                    title: "Reinstate the agent first",
                    operationId: "Operator_reinstateAgent",
                    args: { agentId },
                  },
                ]
              : [],
            `${agentId} is ${stands}, where ${command} is not allowed.`,
          );
        if (command === "Suspend") {
          standing.set(agentId, "suspended");
          pauses.set(agentId, typeof reason === "string" ? reason : "");
        } else {
          standing.delete(agentId);
          pauses.delete(agentId);
        }
        if (ending) behind.delete(agentId);
        return Response.json(profileOf(known));
      }

      // The agents in an org: Keel's three operations, decided as its policy and its handlers decide them and
      // in their order (`authorize.ts`, `apps/keel/src/adapters/driving/http/invitations.ts`). Keel reads anyone
      // the agents that have joined, each by who it is; it reads a member the invitations not yet answered
      // too, with what each gives and whose it is. A namespace that is no org has none, and takes none.
      const among = /^\/v1\/namespaces\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(url.pathname);
      if (among !== null) {
        const org = decodeURIComponent(among[1] ?? "").toLowerCase();
        const agentId = among[2] === undefined ? undefined : decodeURIComponent(among[2]);
        const kind =
          (await options.whose?.(org))?.kind ??
          ([...keyed.values()].includes(org)
            ? "agent"
            : org === project.namespace.handle
              ? project.namespace.kind
              : undefined);
        const role =
          reader?.id === undefined
            ? undefined
            : ((await options.roleIn?.(reader.id, org)) ??
              (org === project.namespace.handle ? reader.role : undefined));
        const rows = invited.get(org) ?? new Map<string, Invited>();
        if (agentId === undefined && request.method === "GET") {
          if (kind === undefined) return gone();
          const members = kind === "org" && role !== undefined;
          return Response.json({
            items: [...rows.values()]
              .filter((row) => members || row.state === "joined")
              .map((row) => rowOf(row, members)),
          } satisfies NamespaceAgents);
        }
        const inviting = agentId === undefined && request.method === "POST";
        const removing = agentId !== undefined && request.method === "DELETE";
        if (inviting || removing) {
          if (reader === null || reader.id === undefined) return problem(401, "auth.required");
          if (request.headers.get("origin") !== url.origin) return problem(403, "auth.cross_site");
          const key = request.headers.get("idempotency-key") ?? "";
          const body = fields(sent);
          const named = body.get("agent");
          const asked = body.get("scopes") ?? ["agent:read", "agent:work"];
          // Keel's own validators answer first: the key, and for an invitation a handle and one or two scopes.
          if (!keyed128(key)) return problem(400, "request.invalid");
          if (
            inviting &&
            (typeof named !== "string" ||
              !AGENT_HANDLE.test(named) ||
              !Array.isArray(asked) ||
              asked.length < 1 ||
              asked.length > 2 ||
              !asked.every((scope) => scope === "agent:read" || scope === "agent:work"))
          )
            return problem(400, "request.invalid");
          // The policy: a namespace that is no org is not there, and a move in one is a member's.
          if (kind !== "org") return gone();
          if (inviting) {
            if (role === undefined) return lacksIn("a member");
            if (reader.fresh !== true) return staleSignIn();
            const scopes: Invited["scopes"] = Array.isArray(asked)
              ? asked.filter((scope) => scope === "agent:read" || scope === "agent:work")
              : [];
            if (!scopes.includes("agent:read") || new Set(scopes).size !== scopes.length)
              return problem(
                400,
                "request.invalid",
                [],
                "An invitation gives agent:read, or agent:read and agent:work, each named once.",
              );
            // An agent's handle is its own namespace's. A person's or an org's, and nobody's, are one answer.
            const invitee = [...agents.values()].find((agent) => agent.handle === named);
            if (invitee === undefined)
              return problem(
                404,
                "resource.not_found",
                [],
                `No agent has the handle ${String(named)}.`,
              );
            const print = `${reader.id} ${[...scopes].toSorted().join(" ")}`;
            const cause = `invite ${org} ${invitee.id} ${key}`;
            const done = moves.get(cause);
            const placed = rows.get(invitee.id);
            // The same request asked again under its key is answered as it was; the key on another is refused.
            if (done !== undefined && done !== print)
              return problem(
                409,
                "request.idempotency_conflict",
                [
                  {
                    kind: "call",
                    title: "Call again with a fresh Idempotency-Key",
                    operationId: "Namespaces_inviteAgent",
                  },
                ],
                `Idempotency-Key ${key} was used for a different move on this invitation.`,
              );
            if (done !== undefined && placed !== undefined)
              return Response.json(rowOf(placed, true), { status: 201 });
            // One member answers for an agent in an org. The same member asking the same again changes nothing.
            if (placed !== undefined) {
              const same =
                placed.by === reader.id &&
                [...placed.scopes].toSorted().join(" ") === [...scopes].toSorted().join(" ");
              if (!same)
                return problem(
                  409,
                  "invitation.state_refused",
                  [
                    {
                      kind: "read",
                      title: "Read the org's agents and who invited each",
                      operationId: "Namespaces_listAgents",
                    },
                  ],
                  `${invitee.id} already has an invitation here, and one member answers for an agent in an org. Take it out first to invite it again or to change what it may do.`,
                );
              return Response.json(rowOf(placed, true), { status: 201 });
            }
            const row: Invited = {
              agentId: invitee.id,
              by: reader.id,
              scopes,
              state: "invited",
              invitedAt: new Date(now()).toISOString(),
            };
            invited.set(org, rows.set(invitee.id, row));
            moves.set(cause, print);
            return Response.json(rowOf(row, true), { status: 201 });
          }
          // A removal is the inviter's, a maintainer's or an owner's: anyone else is told who to ask, whether
          // or not the agent has a place here.
          const placed = rows.get(agentId ?? "");
          if (
            role === undefined ||
            (role === "member" && (placed === undefined || placed.by !== reader.id))
          )
            return lacksIn("a maintainer or an owner");
          if (reader.fresh !== true) return staleSignIn();
          const cause = `end ${org} ${agentId ?? ""} ${key}`;
          const done = ended.get(cause);
          if (done !== undefined) return Response.json(done);
          if (placed === undefined) return gone();
          rows.delete(placed.agentId);
          const answer = rowOf(placed, true, "ended");
          ended.set(cause, answer);
          return Response.json(answer);
        }
      }

      // A namespace's credentials and a project's deploy targets: Keel's six delivery operations, decided
      // as Keel's policy and its handlers decide them and in their order (`authorize.ts`, `delivery.ts`,
      // `deploy-targets.ts`). Each is its namespace's owner's alone: Keel reads a namespace to anyone, so anyone
      // else is refused by role; a project it does not read them is not there.
      const refusedRole = (kind: NamespaceRef["kind"] | undefined): Response =>
        kind === "org"
          ? lacksIn("an owner")
          : problem(
              403,
              "auth.forbidden",
              [
                {
                  kind: "escalate",
                  title: `This is ${kind === "agent" ? "an agent's own" : "a person's own"} namespace and has no members: only its owner does this. Use your own namespace, or an org you are a member of`,
                },
              ],
              "Refused: role.",
            );
      const kindOf = async (handle: string): Promise<NamespaceRef["kind"] | undefined> =>
        (await options.whose?.(handle))?.kind ??
        ([...keyed.values()].includes(handle)
          ? "agent"
          : handle === project.namespace.handle
            ? project.namespace.kind
            : undefined);
      /** Whether the reader owns the namespace of that handle: a person's own is theirs, an org's is its owners'. */
      const owns = async (handle: string, kind: NamespaceRef["kind"]): Promise<boolean> => {
        if (reader?.id === undefined) return false;
        if (handle === project.namespace.handle && reader.role === "owner") return true;
        if (kind === "org") return (await options.roleIn?.(reader.id, handle)) === "owner";
        return (await options.whose?.(handle))?.id === reader.id;
      };
      const credentialsOf = /^\/v1\/namespaces\/([^/]+)\/credentials(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
      if (credentialsOf !== null) {
        const handle = decodeURIComponent(credentialsOf[1] ?? "").toLowerCase();
        const credentialId =
          credentialsOf[2] === undefined ? undefined : decodeURIComponent(credentialsOf[2]);
        const listing = credentialId === undefined && request.method === "GET";
        const storing = credentialId === undefined && request.method === "POST";
        const removing = credentialId !== undefined && request.method === "DELETE";
        if (listing || storing || removing) {
          if (reader === null || reader.id === undefined) return problem(401, "auth.required");
          if (!listing && request.headers.get("origin") !== url.origin)
            return problem(403, "auth.cross_site");
          const body = fields(sent);
          const label = body.get("label");
          const secret = body.get("secret");
          if (
            storing &&
            (typeof label !== "string" ||
              label.length > 64 ||
              !CREDENTIAL_LABEL.test(label) ||
              body.get("provider") !== "cloudflare" ||
              typeof secret !== "string" ||
              secret.length < 1 ||
              secret.length > 4096)
          )
            return problem(400, "request.invalid");
          const kind = await kindOf(handle);
          if (kind === undefined) return gone();
          if (!(await owns(handle, kind))) return refusedRole(kind);
          const held = stored.get(handle) ?? [];
          if (listing)
            return Response.json({
              credentials: held.map((one) => one.credential),
            } satisfies Credentials);
          if (storing && typeof label === "string" && typeof secret === "string") {
            const credential: Credential = {
              id: `crd_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`,
              label,
              provider: "cloudflare",
              createdAt: new Date(now()).toISOString(),
              createdBy: reader.id,
            };
            stored.set(handle, [...held, { credential, secret }]);
            return Response.json(credential satisfies Credential, { status: 201 });
          }
          // A credential is deleted whatever target still names it: the target keeps the id.
          if (!held.some((one) => one.credential.id === credentialId))
            return problem(
              404,
              "resource.not_found",
              [],
              `The namespace holds no credential ${String(credentialId)}.`,
            );
          stored.set(
            handle,
            held.filter((one) => one.credential.id !== credentialId),
          );
          return new Response(null, { status: 204 });
        }
      }
      const targetsOf = /^\/v1\/projects\/([^/]+)\/deploy-targets(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
      if (targetsOf !== null) {
        const projectId = decodeURIComponent(targetsOf[1] ?? "");
        const name = targetsOf[2] === undefined ? undefined : decodeURIComponent(targetsOf[2]);
        const listing = name === undefined && request.method === "GET";
        const setting = name !== undefined && request.method === "PUT";
        const clearing = name !== undefined && request.method === "DELETE";
        if (listing || setting || clearing) {
          if (reader === null || reader.id === undefined) return problem(401, "auth.required");
          if (!listing && request.headers.get("origin") !== url.origin)
            return problem(403, "auth.cross_site");
          const body = fields(sent);
          const accountId = body.get("accountId");
          const credential = body.get("credential");
          if (
            setting &&
            (!TARGET_NAME.test(name ?? "") ||
              body.get("provider") !== "cloudflare" ||
              typeof accountId !== "string" ||
              !ACCOUNT_ID.test(accountId) ||
              typeof credential !== "string" ||
              credential === "")
          )
            return problem(400, "request.invalid");
          const mine = [...made.values()].find((one) => one.view.id === projectId);
          // The project as this caller is read it, and its namespace.
          const here =
            projectId === project.id
              ? visible
                ? project.namespace
                : undefined
              : mine !== undefined && mine.by === reader.id
                ? mine.view.namespace
                : undefined;
          if (here === undefined) return gone();
          if (!(await owns(here.handle, here.kind))) return refusedRole(here.kind);
          const set = targeted.get(projectId) ?? new Map<string, DeployTargetView>();
          if (listing)
            return Response.json({
              targets: [...set.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
            } satisfies DeployTargets);
          if (clearing) {
            if (!set.has(name))
              return problem(
                404,
                "resource.not_found",
                [],
                `The project has no deploy target named ${name}.`,
              );
            set.delete(name);
            return new Response(null, { status: 204 });
          }
          if (name === undefined || typeof accountId !== "string" || typeof credential !== "string")
            return problem(400, "request.invalid");
          const using = (stored.get(here.handle.toLowerCase()) ?? []).find(
            (one) => one.credential.id === credential,
          );
          if (using === undefined)
            return problem(
              409,
              "deploy_target.refused",
              [
                {
                  kind: "read",
                  title: "Read the namespace's credentials",
                  operationId: "Delivery_listCredentials",
                },
                {
                  kind: "call",
                  title:
                    "Store a Cloudflare API token that may edit Workers on the account, then set the target with it",
                  operationId: "Delivery_createCredential",
                },
              ],
              `Deploy target ${name} names a credential this project's namespace does not hold. A target uses only a credential of its own project's namespace.`,
            );
          const reached = cloudflare({ secret: using.secret, accountId });
          const code =
            reached.reaches || reached.code === undefined
              ? ""
              : ` (Cloudflare error ${reached.code})`;
          const storeAnother: NextAction = {
            kind: "call",
            title:
              "Store a Cloudflare API token that may edit Workers on the account, then set the target with it",
            operationId: "Delivery_createCredential",
          };
          if (!reached.reaches)
            return problem(
              422,
              "deploy_target.unreachable",
              [storeAnother],
              reached.why === "token-invalid"
                ? `Cloudflare refused the credential's token${code}: it is invalid, expired or revoked. Nothing was set.`
                : `The credential's token does not reach the account's Workers${code}: check the account id, and that the token may edit Workers on that account. Nothing was set.`,
            );
          if (reached.subdomain === undefined)
            return problem(
              422,
              "deploy_target.no_workers_dev",
              [
                {
                  kind: "call",
                  title: "Set the target again once the account has a workers.dev subdomain",
                  operationId: "Delivery_putDeployTarget",
                },
              ],
              "The account has no workers.dev subdomain to serve previews from. Keel never makes one: set a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages → your subdomain), then set the target again. Nothing was set.",
            );
          const target: DeployTargetView = {
            name,
            provider: "cloudflare",
            accountId,
            credential,
            workersDev: `${reached.subdomain}.workers.dev`,
          };
          if (!set.has(name) && set.size >= TARGETS_MOST)
            return problem(
              409,
              "deploy_target.refused",
              [
                {
                  kind: "read",
                  title: "Read the project's deploy targets",
                  operationId: "Delivery_listDeployTargets",
                },
              ],
              `The project already has all the deploy targets it may, so ${name} was not set. Clear one first, or set one already there again.`,
            );
          set.set(name, target);
          targeted.set(projectId, set);
          return Response.json(target satisfies DeployTargetView);
        }
      }
      // The agents invited to one project: Keel's three operations on a project of a person's own namespace,
      // decided as its policy and its handlers decide them and in their order. Keel reads the owner the
      // invitations not yet answered and what each gives; anyone else who reads the project, the agents that
      // have joined. An org's project has none of its own and takes none: it is not there for the two moves.
      const invitedHere = /^\/v1\/projects\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(url.pathname);
      if (invitedHere !== null) {
        const projectId = decodeURIComponent(invitedHere[1] ?? "");
        const agentId =
          invitedHere[2] === undefined ? undefined : decodeURIComponent(invitedHere[2]);
        const mine = [...made.values()].find((one) => one.view.id === projectId);
        // The project as this caller is read it, whose it is, and whether the caller is its owner.
        const here =
          projectId === project.id
            ? visible
              ? { kind: project.namespace.kind, owner: reader?.role === "owner" }
              : undefined
            : mine !== undefined && mine.by === reader?.id
              ? { kind: mine.view.namespace.kind, owner: true }
              : undefined;
        const rows = invitedTo.get(projectId) ?? new Map<string, Invited>();
        if (agentId === undefined && request.method === "GET") {
          if (here === undefined) return gone();
          const owner = here.kind === "user" && here.owner;
          return Response.json({
            items: [...rows.values()]
              .filter((row) => owner || row.state === "joined")
              .map((row) => rowOf(row, owner)),
          } satisfies ProjectAgents);
        }
        const inviting = agentId === undefined && request.method === "POST";
        const removing = agentId !== undefined && request.method === "DELETE";
        if (inviting || removing) {
          if (reader === null || reader.id === undefined) return problem(401, "auth.required");
          if (request.headers.get("origin") !== url.origin) return problem(403, "auth.cross_site");
          const key = request.headers.get("idempotency-key") ?? "";
          const body = fields(sent);
          const named = body.get("agent");
          const asked = body.get("scopes") ?? ["agent:read", "agent:work"];
          if (!keyed128(key)) return problem(400, "request.invalid");
          if (
            inviting &&
            (typeof named !== "string" ||
              !AGENT_HANDLE.test(named) ||
              !Array.isArray(asked) ||
              asked.length < 1 ||
              asked.length > 2 ||
              !asked.every((scope) => scope === "agent:read" || scope === "agent:work"))
          )
            return problem(400, "request.invalid");
          // The policy: a project that is not there for the caller, or is no person's own, is not there; then
          // only its owner does this, and is told so as Keel tells it of a namespace with no members.
          if (here === undefined || here.kind !== "user") return gone();
          if (!here.owner)
            return problem(
              403,
              "auth.forbidden",
              [
                {
                  kind: "escalate",
                  title:
                    "This is a person's own namespace and has no members: only its owner does this. Use your own namespace, or an org you are a member of",
                },
              ],
              "Refused: role.",
            );
          if (reader.fresh !== true) return staleSignIn();
          if (inviting) {
            const scopes: Invited["scopes"] = Array.isArray(asked)
              ? asked.filter((scope) => scope === "agent:read" || scope === "agent:work")
              : [];
            if (!scopes.includes("agent:read") || new Set(scopes).size !== scopes.length)
              return problem(
                400,
                "request.invalid",
                [],
                "An invitation gives agent:read, or agent:read and agent:work, each named once.",
              );
            const invitee = [...agents.values()].find((agent) => agent.handle === named);
            if (invitee === undefined)
              return problem(
                404,
                "resource.not_found",
                [],
                `No agent has the handle ${String(named)}.`,
              );
            const terms = [...scopes].toSorted().join(" ");
            const cause = `invite ${projectId} ${invitee.id} ${key}`;
            const done = moves.get(cause);
            const placed = rows.get(invitee.id);
            if (done !== undefined && done !== terms)
              return problem(
                409,
                "request.idempotency_conflict",
                [
                  {
                    kind: "call",
                    title: "Call again with a fresh Idempotency-Key",
                    operationId: "Projects_inviteAgent",
                  },
                ],
                `Idempotency-Key ${key} was used for a different move on this invitation.`,
              );
            // The same terms asked again change nothing and are answered the row as it stands; other terms
            // are refused until the agent is taken off.
            if (placed !== undefined) {
              if ([...placed.scopes].toSorted().join(" ") !== terms)
                return problem(
                  409,
                  "invitation.state_refused",
                  [
                    {
                      kind: "read",
                      title: "Read the agents invited to the project",
                      operationId: "Projects_listAgents",
                    },
                  ],
                  `${invitee.id} already has an invitation to this project. Take it off first to invite it again or to change what it may do.`,
                );
              return Response.json(rowOf(placed, true), { status: 201 });
            }
            const row: Invited = {
              agentId: invitee.id,
              by: reader.id,
              scopes,
              state: "invited",
              invitedAt: new Date(now()).toISOString(),
            };
            invitedTo.set(projectId, rows.set(invitee.id, row));
            moves.set(cause, terms);
            return Response.json(rowOf(row, true), { status: 201 });
          }
          const cause = `end ${projectId} ${agentId ?? ""} ${key}`;
          const done = ended.get(cause);
          if (done !== undefined) return Response.json(done);
          const placed = rows.get(agentId ?? "");
          if (placed === undefined) return gone();
          rows.delete(placed.agentId);
          const answer = rowOf(placed, true, "ended");
          ended.set(cause, answer);
          return Response.json(answer);
        }
      }

      // Whose a handle is, Keel answers anyone: that a handle is someone's is no secret, and what it holds is.
      const whose = /^\/v1\/namespaces\/([^/]+)$/.exec(url.pathname);
      if (whose !== null && request.method === "GET") {
        const handle = decodeURIComponent(whose[1] ?? "");
        const known = await options.whose?.(handle);
        if (known !== undefined) return Response.json({ handle, ...known } satisfies NamespaceView);
        // An agent's handle is its own namespace, under the agent's own id.
        const its = [...keyed].find(([, held]) => held === handle)?.[0];
        if (its !== undefined)
          return Response.json({ id: its, handle, kind: "agent" } satisfies NamespaceView);
        if (handle !== project.namespace.handle) return gone();
        return Response.json({
          id: FIXTURE_IDS[project.namespace.kind],
          ...project.namespace,
        } satisfies NamespaceView);
      }

      const named = /^\/v1\/namespaces\/([^/]+)\/projects\/([^/]+)$/.exec(url.pathname);
      if (named !== null && request.method === "GET") {
        const [, handle = "", name = ""] = named.map((part) => decodeURIComponent(part));
        const mine = madeAt(handle, name);
        if (mine !== undefined)
          return mine.by === reader?.id ? Response.json(shown(mine) satisfies ProjectView) : gone();
        if (!visible || handle !== project.namespace.handle || name !== project.name) return gone();
        return Response.json({
          ...project,
          ...(reader?.role === undefined ? {} : { viewer: { role: reader.role } }),
        } satisfies ProjectView);
      }
      if (url.pathname === "/v1/projects" && request.method === "GET")
        return Response.json({
          items: [
            ...(visible ? [project] : []),
            ...[...made.values()].filter((one) => one.by === reader?.id).map((one) => one.view),
          ],
        });

      // Making a project: Keel's `createProject`, answered in its handler's order and its sentences
      // (`apps/keel/src/adapters/driving/http/operator.ts`). A refused start makes no project.
      if (url.pathname === "/v1/projects" && request.method === "POST") {
        if (reader === null) return problem(401, "auth.required");
        if (request.headers.get("origin") !== url.origin) return problem(403, "auth.cross_site");
        const body = fields(sent);
        const key = request.headers.get("idempotency-key") ?? "";
        const handle = body.get("namespace");
        const name = body.get("name");
        const source = fields(JSON.stringify(body.get("source") ?? null));
        const kind = source.get("kind");
        const address = source.get("url");
        const forked = source.get("project");
        if (
          key.length < 8 ||
          typeof handle !== "string" ||
          typeof name !== "string" ||
          name === "" ||
          (kind !== "empty" && kind !== "import" && kind !== "fork") ||
          (kind === "import" && typeof address !== "string") ||
          (kind === "fork" && (typeof forked !== "string" || !PROJECT_ID.test(forked)))
        )
          return problem(400, "request.invalid");
        // Whose the namespace is: the project's own, where any member may make one, or the reader's own handle.
        const own = (await options.whose?.(handle))?.id === reader.id && reader.id !== undefined;
        if (handle === project.namespace.handle ? !member : !own) {
          const known =
            handle === project.namespace.handle || (await options.whose?.(handle)) !== undefined;
          return !known
            ? gone()
            : problem(
                403,
                "auth.forbidden",
                [{ kind: "escalate", title: "Ask a member: this needs that role" }],
                "Refused: role.",
              );
        }
        // The project to fork is a second thing the body names, decided as Keel's `fork` decides it
        // (`authorize.ts`), after the namespace: one this reader is not read is no project at all, and a
        // private one forks only into its own namespace. A fork is made private, whatever its source is.
        if (kind === "fork") {
          const theirs = [...made.values()].find(
            (one) => one.view.id === forked && one.by === reader.id,
          )?.view;
          const from = forked === project.id ? (visible ? project : undefined) : theirs;
          if (from === undefined) return gone();
          if (from.visibility === "private" && from.namespace.handle !== handle)
            return problem(
              403,
              "auth.forbidden",
              [
                {
                  kind: "escalate",
                  title:
                    "A private project forks only into its own namespace; ask whoever maintains it to make it public",
                },
              ],
              "Refused: private-source.",
            );
        }
        if (typeof address === "string" && !address.startsWith("https://"))
          return problem(
            400,
            "request.invalid",
            [again("Correct the import's url, then create the project again")],
            "The import's url must begin with https:// (not-https).",
          );
        const held = made.get(key);
        if (held !== undefined)
          return held.asked === sent
            ? Response.json(shown(held), { status: 201 })
            : problem(
                409,
                "request.idempotency_conflict",
                [again("Call again with a fresh Idempotency-Key")],
                `Idempotency-Key ${key} was used for a different project.`,
              );
        if (
          madeAt(handle, name) !== undefined ||
          (handle === project.namespace.handle && name.toLowerCase() === project.name)
        )
          return problem(
            409,
            "project.name_taken",
            [again("Choose another name")],
            `${handle.toLowerCase()} already has a project named "${name.toLowerCase()}" (names ignore letter case).`,
          );
        // One public repository answers here. Any other address is to Keel as a private one is: nothing there.
        if (typeof address === "string" && address !== PUBLIC_REPOSITORY)
          return problem(
            404,
            "project.import_refused",
            [again("Check the URL names a public repository, then create the project again")],
            "No public repository answers at that URL. A private one reads the same. Nothing was imported, and no project was made (not-found).",
          );
        const view: ProjectView = {
          id: `prj_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`,
          namespace:
            handle === project.namespace.handle ? project.namespace : { handle, kind: "user" },
          name: name.toLowerCase(),
          visibility: "private",
          createdAt: new Date(now()).toISOString(),
          viewer: { role: reader.role ?? "owner" },
        };
        const one = {
          asked: sent,
          by: reader.id ?? "",
          view,
          ...(kind === "fork" && typeof forked === "string" ? { from: forked } : {}),
        };
        made.set(key, one);
        return Response.json(shown(one), { status: 201 });
      }

      // A project's repository is read by whoever the project is shown to.
      const repoRead = /^\/v1\/projects\/([^/]+)\/repo\/(tree|blob|commits)(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
      if (repoRead !== null && request.method === "GET") {
        const [, projectId = "", what, sha] = repoRead;
        if (!visible) return gone();
        const asked = (name: string): { [key: string]: string } => {
          const value = url.searchParams.get(name);
          return value === null ? {} : { [name]: value };
        };
        try {
          if (what === "tree") {
            const tree: RepoTree = await repository.getTree(projectId, {
              ...asked("ref"),
              path: url.searchParams.get("path") ?? "",
            });
            return Response.json(tree);
          }
          if (what === "blob") {
            const blob: RepoBlob = await repository.getBlob(projectId, {
              ...asked("ref"),
              path: url.searchParams.get("path") ?? "",
            });
            return Response.json(blob);
          }
          if (sha === undefined) {
            const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
            const page: RepoCommitPage = await repository.getCommits(projectId, {
              ...asked("ref"),
              ...asked("cursor"),
              limit,
            });
            return Response.json(page);
          }
          const commit: RepoCommitDiff = await repository.getCommit(projectId, sha);
          return Response.json(commit);
        } catch (error) {
          return error instanceof RepoRefused
            ? problem(error.status, error.code)
            : problem(404, "resource.not_found");
        }
      }

      if (url.pathname === "/v1/events" && request.method === "GET") {
        const asked = url.searchParams.get("project");
        // A log is one project's. Asked for none, someone signed in is read every project Keel may read them,
        // and a visitor is asked for a session: the spec's "without a token and without `project`, 401".
        if (asked === null && reader === null) return problem(401, "auth.required");
        const mine = [...made.values()].find((one) => one.view.id === asked);
        if (mine !== undefined && mine.by === reader?.id) {
          // Nothing has been written in it yet. A waiting read is held a moment, as Keel holds one.
          if (url.searchParams.has("wait"))
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 1000);
            });
          const at = url.searchParams.get("cursor") ?? "0";
          return Response.json({
            items: [],
            nextCursor: at === "end" ? "0" : at,
          } satisfies EventPage);
        }
        if (asked !== null && (asked !== project.id || !visible)) return gone();
        const cursor = url.searchParams.get("cursor") ?? "0";
        // A cursor is a place an earlier page gave, or Keel's word for the head. Anything else is refused.
        if (cursor !== "end" && !/^\d+$/.test(cursor)) return problem(400, "request.invalid");
        const wait = Number(url.searchParams.get("wait") ?? "0") || 0;
        const head = ahead + log.events.length;
        // Asked for the head with no wait, Keel answers no entry and where its log ends now.
        if (cursor === "end" && wait === 0)
          return Response.json({ items: [], nextCursor: String(head) } satisfies EventPage);
        const from = cursor === "end" ? head : Number(cursor);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "500") || 500, pageSize);
        // A stretch of the instance's log that is all other projects' is an empty page, and the cursor moves on.
        if (from < ahead)
          return Response.json({ items: [], nextCursor: String(Math.min(from + limit, ahead)) });
        const start = from - ahead;
        if (start >= log.events.length && wait > 0) {
          // Nothing new: hold the request until the log grows or the wait runs out.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, wait * 1000);
            waiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
        // A published record is the envelope Keel's contract has, and nothing of Keel's own beside it: not what caused the event.
        // A page is cut from the whole log, and a reader who is no member is then read the public part of it:
        // the cursor moves on past what they were not shown.
        const cut = log.events.slice(start, start + limit);
        const items = cut
          // With no project named, someone signed in is read every project Keel may read them: this one as its
          // member, its public part where it is public, and nothing of it otherwise.
          .filter((event) => member || (visible && !MEMBERS_ONLY.has(event.type)))
          .filter((event) => event.type !== "AgentEnrolled" || !keyed.has(event.payload.agentId))
          .map(
            ({
              eventId,
              type,
              entity,
              seq,
              at,
              payload,
              label,
              actor,
              run,
              project: stamped,
            }): Omit<EventRecord, "payload"> & { payload: AnyEvent["payload"] } => ({
              eventId,
              type,
              entity,
              seq,
              at,
              payload:
                options.verdictViews === false
                  ? unsummarised(unpriced(payload))
                  : unpriced(payload),
              ...(label === undefined ? {} : { label }),
              ...(actor === undefined ? {} : { actor }),
              ...(run === undefined ? {} : { run }),
              ...(stamped === undefined ? {} : { project: stamped }),
            }),
          );
        // The cursor is always the position just after the last item, so a reader at the tail has something to wait on.
        return Response.json({
          items,
          nextCursor: String(ahead + start + cut.length),
        } satisfies Omit<EventPage, "items"> & { items: unknown[] });
      }

      // A probe's source is read by whoever its project is shown to, file by file, from the bundle its draft
      // was kept under. A probe of another project, and one nobody drafted, are the same answer.
      const probeSource = /^\/v1\/probes\/([^/]+)\/source$/.exec(url.pathname);
      if (probeSource !== null && request.method === "GET") {
        const asked = url.searchParams.get("project");
        if (asked === null && reader === null) return problem(400, "request.invalid");
        if (!visible || (asked !== null && asked !== project.id)) return gone();
        const source = log.probes.get(decodeURIComponent(probeSource[1] ?? ""));
        return source === undefined ? gone() : Response.json(source satisfies ProbeSource);
      }

      if (url.pathname === "/v1/lattices" && request.method === "GET")
        return Response.json(LATTICES satisfies LatticeSet);

      const verdict = /^\/v1\/verdicts\/([^/]+)$/.exec(url.pathname);
      if (verdict !== null && request.method === "GET") {
        if (!visible || options.verdictViews === false) return gone();
        const view = log.verdicts.get(decodeURIComponent(verdict[1] ?? ""));
        return view === undefined
          ? problem(404, "resource.not_found")
          : Response.json(view satisfies VerdictView);
      }

      // A project's settings are read by a member of its namespace and replaced, whole, by a maintainer or an owner.
      // Someone with no session is asked for one before anything is said of the project.
      const ofSettings = /^\/v1\/projects\/([^/]+)\/settings$/.exec(url.pathname);
      if (ofSettings !== null && (request.method === "GET" || request.method === "PUT")) {
        if (reader === null) return problem(401, "auth.required");
        if (request.method === "PUT" && request.headers.get("origin") !== url.origin)
          return problem(403, "auth.cross_site");
        if (!visible || decodeURIComponent(ofSettings[1] ?? "") !== project.id) return gone();
        if (!member) return lacks("a member");
        if (request.method === "GET") return Response.json(settings());
        if (reader.role === "member") return lacks("a maintainer or an owner");
        const body = fields(sent);
        const protectedPaths = body.get("protectedPaths");
        const maxBatchSize = body.get("maxBatchSize");
        const verification = body.get("verification");
        const to = body.get("visibility");
        // The settings are replaced whole: a body that leaves one of Keel's required fields out is refused.
        if (
          !Array.isArray(protectedPaths) ||
          !protectedPaths.every(
            (glob): glob is string => typeof glob === "string" && glob !== "",
          ) ||
          typeof maxBatchSize !== "number"
        )
          return problem(400, "request.invalid");
        kept = {
          protectedPaths,
          maxBatchSize,
          // Left out of a PUT, verification is required and the project is private: Keel's spec says so.
          verification: verification === "off" ? "off" : "required",
        };
        project.visibility = to === "public" ? "public" : "private";
        return Response.json(settings());
      }

      // Keel's memory of the project's decisions, read by whoever reads the project, a visitor to a public
      // one among them (`decisions.ts` among Keel's handlers). The list is of the project it names, a page at
      // a time from after the decision its cursor names; a project this reader is not read is not there.
      if (url.pathname === "/v1/decisions" && request.method === "GET") {
        if (!visible || url.searchParams.get("project") !== project.id) return gone();
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null && !cursor.startsWith("dec_")) return problem(400, "request.invalid");
        const subject = url.searchParams.get("subject");
        const asked = Number(url.searchParams.get("limit") ?? decisionPage);
        const limit = Math.min(Math.max(Number.isInteger(asked) ? asked : decisionPage, 1), 100);
        const matching = remembered().filter(
          (view) => subject === null || view.subject === subject,
        );
        const rest = matching.slice(
          cursor === null ? 0 : matching.findIndex((view) => view.id === cursor) + 1,
        );
        const items = rest.slice(0, limit);
        const last = items.at(-1);
        return Response.json({
          items,
          ...(rest.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
        } satisfies DecisionPage);
      }
      // One decision is read by whoever reads the project it was ruled in. One this reader is not read, and
      // one Keel never recorded, are the same answer, which names only the id that was asked for.
      const remembering = /^\/v1\/decisions\/([^/]+)$/.exec(url.pathname);
      if (remembering !== null && request.method === "GET") {
        const id = decodeURIComponent(remembering[1] ?? "");
        const view = visible ? remembered().find((one) => one.id === id) : undefined;
        return view === undefined
          ? problem(
              404,
              "decision.not_found",
              [
                {
                  kind: "read",
                  title: "List the project's decisions",
                  operationId: "Memory_listDecisions",
                },
              ],
              `No decision ${id} in a project you can read.`,
            )
          : Response.json(view satisfies DecisionView);
      }

      // A person's own questions, across their projects: one whose agent names them, at once; one of a
      // namespace they maintain, once the person asked first has had `MAINTAINERS_AFTER_MS`, or at once where
      // nobody is named. Only of a project Keel reads them as a member (`listedTo`, and the doorway's `placeOf`).
      if (url.pathname === "/v1/escalations" && request.method === "GET") {
        if (reader === null) return problem(401, "auth.required");
        const asked = raised();
        const state = url.searchParams.get("state");
        const maintainer = reader.role === "owner" || reader.role === "maintainer";
        const listed =
          asked !== undefined &&
          member &&
          (state === null || state === (ruled === undefined ? "open" : "ruled")) &&
          (reader.sponsor === true ||
            (maintainer && (!sponsored || now() - Date.parse(asked.at) >= MAINTAINERS_AFTER_MS)));
        return Response.json({
          items: listed ? [viewOf(asked)] : [],
        } satisfies EscalationPage);
      }

      const ruling = /^\/v1\/escalations\/([^/]+)\/ruling$/.exec(url.pathname);
      if (ruling !== null && request.method === "POST") {
        // A question is answered by a person: one who is signed in, on a page of Keel's own site, and a member
        // of the project's namespace. Whoever the project is not shown to is told there is no such question.
        const asking = decodeURIComponent(ruling[1] ?? "");
        if (!visible) return noQuestion(asking);
        if (reader === null) return problem(401, "auth.required");
        // A page of another site, and a call that names no site, are refused alike.
        if (request.headers.get("origin") !== url.origin) return problem(403, "auth.cross_site");
        if (!member)
          return problem(403, "auth.forbidden", [
            {
              kind: "escalate",
              title: `Ask an owner of ${project.namespace.handle} to make you a member`,
            },
          ]);
        if (asking !== escalationId) return noQuestion(asking);
        // A ruling is the person's the question was put to first, or a maintainer's: Keel's `sponsorOrMaintain`.
        if (reader.sponsor !== true && reader.role === "member")
          return lacks("the person the question was put to, or a maintainer or an owner");
        const key = request.headers.get("idempotency-key") ?? "";
        const asked = raised();
        if (asked === undefined) return noQuestion(asking);
        // A ruling answers with the question as it now stands.
        const view = (): EscalationView => ({ ...viewOf(asked), state: "ruled" });
        const body = fields(sent);
        const option = body.get("option");
        // A body Keel cannot read is refused before the domain sees it.
        if (typeof option !== "string") return problem(400, "request.invalid");
        // The same command again is answered as it was. The same key on another command is a conflict, as it is
        // on every operation of Keel's that takes a key; and any other command finds the question closed.
        if (ruled !== undefined) {
          if (ruled.key !== key)
            return problem(
              409,
              "escalation.state_refused",
              [],
              `${asking} is ruled: it takes one ruling, while it is open.`,
            );
          return ruled.option === option
            ? Response.json(view())
            : problem(409, "request.idempotency_conflict");
        }
        // Keel has no 422: an option the escalation does not have is refused by the domain, as a 400 with this
        // code, and its next actions name the options there are.
        if (!isRuling(option)) {
          return problem(
            400,
            "escalation.option_unknown",
            S1_CHOICES.map((choice) => ({
              kind: "call",
              title: choice.label,
              operationId: "Operator_giveRuling",
              args: { option: choice.id },
            })),
            `${asking} does not offer the option ${option}.`,
          );
        }
        ruled = { option, key };
        log = generateS1(seed, option);
        const woken = waiters;
        waiters = [];
        for (const wake of woken) wake();
        return Response.json(view());
      }

      return problem(404, "resource.not_found");
    },
  };
}
