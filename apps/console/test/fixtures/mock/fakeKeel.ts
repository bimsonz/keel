// A stand-in for Keel's API, for tests. It serves scenario 1's log the way the
// spec says Keel does: client-credentials tokens with scopes, events by cursor
// with the cursor always given, a verdict's evidence by its id, and a ruling an
// operator may give once. Its answers are typed by Keel's own generated wire
// types. The one place it is ahead of them is an event's payload, which it
// serves as Keel's design settles it (contract/events.ts, `Ahead`).
// Nothing in the built console imports this.

import type { AnyEvent } from "../../../src/contract/events.ts";
import type {
  EscalationView,
  EventPage,
  EventRecord,
  LatticeSet,
  NextAction,
  RepoBlob,
  RepoCommitDiff,
  RepoCommitPage,
  RepoTree,
  TokenResponse,
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

export interface Client {
  id: string;
  secret: string;
  scopes: string[];
}

export interface Call {
  method: string;
  /** The host the request was addressed to. */
  host: string;
  path: string;
  query: string;
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
  /** Makes every token issued so far stale, as an early expiry would. */
  revokeTokens(): void;
  /** Answers every authenticated request with 401 from now on, whatever the token. */
  refuseEveryone(): void;
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

export function createFakeKeel(options: {
  clients: Client[];
  seed?: number;
  pageSize?: number;
  /** Who may read the project's repository with no token. Keel creates a project private. */
  visibility?: "public" | "private";
}): FakeKeel {
  const seed = options.seed ?? 42;
  const pageSize = options.pageSize ?? 500;
  let log = generateS1(seed);
  const repository = createMockRepository(() => log);
  const visibility = options.visibility ?? "private";
  const escalationId = log.gates[0]?.escalationId ?? "";
  let ruled: { option: string; key: string } | undefined;
  let waiters: (() => void)[] = [];
  let refusing = false;
  const tokens = new Map<string, string[]>();
  const calls: Call[] = [];
  let issued = 0;

  /** The question as the log raised it: Keel's view of an escalation is that event's own fields. */
  const raised = () => log.events.find((event) => event.type === "EscalationRaised");
  const scopesOf = (request: Request): string[] | undefined =>
    refusing
      ? undefined
      : tokens.get(/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");

  return {
    calls,
    events: () => log.events,
    revokeTokens: () => tokens.clear(),
    refuseEveryone: () => {
      refusing = true;
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

      if (url.pathname === "/v1/oauth/token" && request.method === "POST") {
        const form = new URLSearchParams(sent);
        const client = options.clients.find(
          (candidate) =>
            candidate.id === form.get("client_id") &&
            candidate.secret === form.get("client_secret"),
        );
        if (client === undefined)
          return Response.json({ error: "invalid_client" }, { status: 401 });
        const asked = (form.get("scope") ?? client.scopes.join(" ")).split(" ");
        if (asked.some((scope) => !client.scopes.includes(scope)))
          return Response.json({ error: "invalid_scope" }, { status: 400 });
        issued += 1;
        const token = `tok_${issued}_${asked.join("+")}`;
        tokens.set(token, asked);
        return Response.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: asked.join(" "),
        } satisfies TokenResponse);
      }

      // A project's repository is read by anyone where the project is public, and by an observer or an agent
      // where it is not. To a reader with no token a private project is the same answer as no project at all.
      const repoRead = /^\/v1\/projects\/([^/]+)\/repo\/(tree|blob|commits)(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
      if (repoRead !== null && request.method === "GET") {
        const [, projectId = "", what, sha] = repoRead;
        const anonymous = !request.headers.has("authorization");
        const reader = anonymous ? [] : scopesOf(request);
        if (reader === undefined) return problem(401, "auth.invalid_token");
        if (anonymous && visibility !== "public") return problem(404, "resource.not_found");
        if (!anonymous && !reader.includes("observer") && !reader.includes("agent:read"))
          return problem(403, "auth.insufficient_scope");
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

      const scopes = scopesOf(request);
      if (scopes === undefined) return problem(401, "auth.invalid_token");

      if (url.pathname === "/v1/events" && request.method === "GET") {
        if (!scopes.includes("observer") && !scopes.includes("agent:read"))
          return problem(403, "auth.insufficient_scope");
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
              project,
            }): Omit<EventRecord, "payload"> & { payload: AnyEvent["payload"] } => ({
              eventId,
              type,
              entity,
              seq,
              at,
              payload: unpriced(payload),
              ...(label === undefined ? {} : { label }),
              ...(actor === undefined ? {} : { actor }),
              ...(project === undefined ? {} : { project }),
            }),
          );
        // The cursor is always the position just after the last item, so a reader at the tail has something to wait on.
        return Response.json({ items, nextCursor: String(start + items.length) } satisfies Omit<
          EventPage,
          "items"
        > & { items: unknown[] });
      }

      if (url.pathname === "/v1/lattices" && request.method === "GET") {
        if (!scopes.includes("observer") && !scopes.includes("agent:read"))
          return problem(403, "auth.insufficient_scope");
        return Response.json(LATTICES satisfies LatticeSet);
      }

      const verdict = /^\/v1\/verdicts\/([^/]+)$/.exec(url.pathname);
      if (verdict !== null && request.method === "GET") {
        if (!scopes.includes("observer") && !scopes.includes("agent:read"))
          return problem(403, "auth.insufficient_scope");
        const view = log.verdicts.get(decodeURIComponent(verdict[1] ?? ""));
        return view === undefined
          ? problem(404, "resource.not_found")
          : Response.json(view satisfies VerdictView);
      }

      const ruling = /^\/v1\/escalations\/([^/]+)\/ruling$/.exec(url.pathname);
      if (ruling !== null && request.method === "POST") {
        if (!scopes.includes("operator")) return problem(403, "auth.insufficient_scope");
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
