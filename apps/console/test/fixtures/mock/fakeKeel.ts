// A stand-in for Keel's API, for tests. It serves scenario 1's one project the
// way Keel does: a reader is whoever the session cookie says, or a visitor;
// a project is found by its org and name; its events are read by cursor with
// the cursor always given, a verdict's evidence by its id, and a member of the
// project's org may answer its question, once. A member reads the project's
// settings, and a maintainer or an owner replaces them, which is how the
// project is made public or private. What a reader may not see is answered as
// what is not there. Its answers are typed by Keel's own generated
// wire types, but for the project, whose shape is the console's read of it
// the read (source/types.ts). An event's payload it serves as
// Keel's design settles it (contract/events.ts, `Ahead`). Nothing in the
// built console imports this.

import type { AnyEvent } from "../../../src/contract/events.ts";
import type {
  EscalationPage,
  EscalationView,
  EventPage,
  EventRecord,
  LatticeSet,
  NextAction,
  ProbeSource,
  ProjectSettings,
  ProjectView,
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

export type Role = NonNullable<ProjectView["viewer"]>["role"];

/**
 * Who a request is from, as Keel's gate reads it: a user, by their session, with the role they have in the
 * project's org where they are a member of it; or null, a visitor. `sponsor` says they are the person the
 * question's agent names: the one Keel asks first.
 */
export type Reader = { role?: Role; sponsor?: boolean } | null;

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
  "RulingGiven",
  "OverruleRequested",
  "SessionOpened",
  "MessagesCaptured",
  "SessionRedacted",
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
  /** The project it holds, as it names it to a reader who is not a member of its org. */
  project: ProjectView;
}

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

export function createFakeKeel(
  options: {
    seed?: number;
    pageSize?: number;
    /** The handle of the org the project is in. */
    org?: string;
    /** Who may read the project with no session. Keel creates a project private. */
    visibility?: "public" | "private";
    /** Sessions, by the value of their cookie: the role each one's user has in the project's org, or none. */
    sessions?: Record<string, Role | "stranger">;
    /** Says who a request is from, in place of `sessions`: for a test that has real sessions to ask about. */
    readerOf?: (request: Request) => Reader | Promise<Reader>;
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
     * How many entries of other projects the instance's log holds ahead of this project's first. Keel's log is
     * the whole instance's: a page is its next stretch with the project's entries picked out, so a stretch
     * that holds none is an empty page whose cursor has moved on.
     */
    ahead?: number;
  } = {},
): FakeKeel {
  const seed = options.seed ?? 42;
  const pageSize = options.pageSize ?? 500;
  const ahead = options.ahead ?? 0;
  let log = generateS1(seed);
  const repository = createMockRepository(() => log);
  const escalationId = log.gates[0]?.escalationId ?? "";
  let ruled: { option: string; key: string } | undefined;
  let waiters: (() => void)[] = [];
  const calls: Call[] = [];
  const created = log.events.find((event) => event.type === "ProjectCreated");
  if (created === undefined) throw new Error("scenario 1 creates no project");
  const project: ProjectView = {
    id: created.payload.projectId,
    namespace: { handle: options.org ?? "acme", kind: "org" },
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
      const sponsor = held === options.sponsor ? { sponsor: true } : {};
      return role === "stranger" ? sponsor : { role, ...sponsor };
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

  return {
    calls,
    events: () => log.events,
    project,
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
      /** The project is shown to its org's members, and to anyone where it is public. To the rest it is not there. */
      const visible = member || project.visibility === "public";
      const gone = (): Response => problem(404, "resource.not_found");

      const named = /^\/v1\/namespaces\/([^/]+)\/projects\/([^/]+)$/.exec(url.pathname);
      if (named !== null && request.method === "GET") {
        const [, org = "", name = ""] = named.map((part) => decodeURIComponent(part));
        if (!visible || org !== project.namespace.handle || name !== project.name) return gone();
        return Response.json({
          ...project,
          ...(reader?.role === undefined ? {} : { viewer: { role: reader.role } }),
        } satisfies ProjectView);
      }
      if (url.pathname === "/v1/projects" && request.method === "GET")
        return Response.json({ items: visible ? [project] : [] });

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
        if (asked !== null && (asked !== project.id || !visible)) return gone();
        const from = Number(url.searchParams.get("cursor") ?? "0") || 0;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "500") || 500, pageSize);
        // A stretch of the instance's log that is all other projects' is an empty page, and the cursor moves on.
        if (from < ahead)
          return Response.json({ items: [], nextCursor: String(Math.min(from + limit, ahead)) });
        const start = from - ahead;
        const wait = Number(url.searchParams.get("wait") ?? "0") || 0;
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
              project: stamped,
            }): Omit<EventRecord, "payload"> & { payload: AnyEvent["payload"] } => ({
              eventId,
              type,
              entity,
              seq,
              at,
              payload: unpriced(payload),
              ...(label === undefined ? {} : { label }),
              ...(actor === undefined ? {} : { actor }),
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
        if (!visible) return gone();
        const view = log.verdicts.get(decodeURIComponent(verdict[1] ?? ""));
        return view === undefined
          ? problem(404, "resource.not_found")
          : Response.json(view satisfies VerdictView);
      }

      // A project's settings are read by a member of its org and replaced, whole, by a maintainer or an owner.
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
        // of the project's org. Whoever the project is not shown to is told there is no such question.
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
