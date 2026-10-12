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
  EscalationView,
  EventPage,
  EventRecord,
  LatticeSet,
  NextAction,
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
 * project's org where they are a member of it; or null, a visitor.
 */
export type Reader = { role?: Role } | null;

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

function problem(status: number, code: string, nextActions: NextAction[] = []): Response {
  const body: ProblemDetails = {
    type: `https://keel.town/problems/${code}`,
    title: code,
    status,
    code,
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
  } = {},
): FakeKeel {
  const seed = options.seed ?? 42;
  const pageSize = options.pageSize ?? 500;
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
    org: options.org ?? "acme",
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
      return role === "stranger" ? {} : { role };
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

      const named = /^\/v1\/orgs\/([^/]+)\/projects\/([^/]+)$/.exec(url.pathname);
      if (named !== null && request.method === "GET") {
        const [, org = "", name = ""] = named.map((part) => decodeURIComponent(part));
        if (!visible || org !== project.org || name !== project.name) return gone();
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
        // A log is one project's. Asked for none, a user is read the projects of their orgs, and a visitor is
        // told to name one.
        if (asked === null && reader === null) return problem(400, "request.invalid");
        if (asked !== null && (asked !== project.id || !visible)) return gone();
        if (asked === null && !member) return Response.json({ items: [], nextCursor: "0" });
        const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "500") || 500, pageSize);
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
        const items = log.events
          .slice(start, start + limit)
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
        return Response.json({ items, nextCursor: String(start + items.length) } satisfies Omit<
          EventPage,
          "items"
        > & { items: unknown[] });
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

      const ruling = /^\/v1\/escalations\/([^/]+)\/ruling$/.exec(url.pathname);
      if (ruling !== null && request.method === "POST") {
        // A question is answered by a person: one who is signed in, on a page of Keel's own site, and a member
        // of the project's org. Whoever the project is not shown to is told there is no such question.
        if (!visible) return gone();
        if (reader === null) return problem(401, "auth.required");
        // A page of another site, and a call that names no site, are refused alike.
        if (request.headers.get("origin") !== url.origin) return problem(403, "auth.cross_site");
        if (!member)
          return problem(403, "auth.forbidden", [
            { kind: "escalate", title: `Ask an owner of ${project.org} to make you a member` },
          ]);
        if (decodeURIComponent(ruling[1] ?? "") !== escalationId)
          return problem(404, "resource.not_found");
        const key = request.headers.get("idempotency-key") ?? "";
        const asked = raised();
        if (asked === undefined) return problem(404, "resource.not_found");
        // A ruling answers with the question as it now stands.
        const { payload } = asked;
        const view = (): EscalationView => ({
          id: payload.escalationId,
          question: payload.question,
          options: payload.options,
          about: payload.about,
          category: payload.category,
          evidence: payload.evidence,
          precedents: payload.precedents,
          default: payload.default,
          raisedAt: asked.at,
          state: "ruled",
        });
        const body = fields(sent);
        const option = body.get("option");
        // A body Keel cannot read is refused before the domain sees it.
        if (typeof option !== "string") return problem(400, "request.invalid");
        // The same command again is answered as it was. The same key on another command is a conflict, as it is
        // on every operation of Keel's that takes a key; and any other command finds the question closed.
        if (ruled !== undefined) {
          if (ruled.key !== key) return problem(409, "escalation.state_refused");
          return ruled.option === option
            ? Response.json(view())
            : problem(409, "request.idempotency_conflict");
        }
        // Keel has no 422: an option the escalation does not have is refused by the domain, as a 400 with this
        // code, and its next actions name the options there are.
        if (!isRuling(option)) {
          return problem(
            400,
            "ruling-option-unknown",
            S1_CHOICES.map((choice) => ({
              kind: "call",
              title: choice.label,
              operationId: "Operator_giveRuling",
              args: { option: choice.id },
            })),
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
