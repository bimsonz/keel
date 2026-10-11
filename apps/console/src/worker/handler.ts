// The console's Worker. The page it serves never holds a credential for Keel; this does.
//
//   GET  /api/v1/…             read Keel: with no token for a visitor, as an observer for the presenter
//   POST /present/capability   the presenter's console asks for a capability to rule on one question
//   POST /rule/<capability>    a ruling, from the console or from a phone that scanned its QR code
//   GET  /healthz
//   anything else              the built page
//
// A visitor's read goes to Keel with no token at all: Keel answers it for a
// public project and for nothing else. The observer reads the whole instance,
// private projects included, so its token is added only to a read that shows
// the presenter's key. The operator's token is used by the ruling route and
// nothing else, and only for the one question a capability names. No token is
// ever sent to a browser.

import { CAPABILITY_TTL, checkCapability, mintCapability } from "../capability.ts";
import type {
  Inbox_listEventsInput,
  Operator_giveRulingInput,
  Repo_getBlobInput,
  Repo_getTreeInput,
  Repo_listCommitsInput,
  Scope as KeelScope,
  TokenRequest,
  TokenResponse,
  WireOutputs,
} from "../contract/keel/index.ts";

/** Something that answers requests: a service binding, or the assets binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** Keel, reached Worker to Worker. */
  KEEL: Fetcher;
  /**
   * Keel's own public host. The binding does not need it, and Keel's REST routes do not check it today; requests
   * are addressed to it all the same, so that a host check added to Keel later breaks nothing here.
   */
  KEEL_API_HOST: string;
  /** The built page. */
  ASSETS: Fetcher;
  KEEL_OBSERVER_CLIENT_ID: string;
  KEEL_OBSERVER_CLIENT_SECRET: string;
  KEEL_OPERATOR_CLIENT_ID: string;
  KEEL_OPERATOR_CLIENT_SECRET: string;
  /** Signs capabilities. */
  CONSOLE_CAPABILITY_KEY: string;
  /** What the presenter's console shows to be allowed to ask for one. */
  CONSOLE_PRESENTER_KEY: string;
}

/** The two of Keel's scopes this Worker holds a credential for. */
type Scope = Extract<KeelScope, "observer" | "operator">;

/** What reading the log may carry: the operation's own inputs, by Keel's names for them. */
const EVENTS_QUERY = [
  "cursor",
  "limit",
  "wait",
] as const satisfies readonly (keyof Inbox_listEventsInput)[];

const TREE_QUERY = ["ref", "path"] as const satisfies readonly (keyof Repo_getTreeInput)[];
const BLOB_QUERY = ["ref", "path"] as const satisfies readonly (keyof Repo_getBlobInput)[];
const COMMITS_QUERY = [
  "ref",
  "cursor",
  "limit",
] as const satisfies readonly (keyof Repo_listCommitsInput)[];

/** One of the reads of a project's repository: the project by Keel's id for it, then what is read. */
const REPO = (rest: string): RegExp => new RegExp(`^/v1/projects/[A-Za-z0-9_]+/repo/${rest}$`);

/**
 * What may be read through the console, and nothing else: each is one of Keel's own operations, the
 * path under /api it is served at, and the query it may carry. An id in a path is one segment of an id's
 * characters, so no path here can be made to name another route.
 */
const READS: readonly { operation: keyof WireOutputs; path: RegExp; query: readonly string[] }[] = [
  { operation: "Inbox_listEvents", path: /^\/v1\/events$/, query: EVENTS_QUERY },
  { operation: "Lattices_listLattices", path: /^\/v1\/lattices$/, query: [] },
  { operation: "Views_getVerdict", path: /^\/v1\/verdicts\/[A-Za-z0-9_]+$/, query: [] },
  // A project's repository. Keel answers these with no token for a public project, and for no other.
  { operation: "Repo_getTree", path: REPO("tree"), query: TREE_QUERY },
  { operation: "Repo_getBlob", path: REPO("blob"), query: BLOB_QUERY },
  { operation: "Repo_listCommits", path: REPO("commits"), query: COMMITS_QUERY },
  { operation: "Repo_getCommit", path: REPO("commits/[0-9a-f]{4,64}"), query: [] },
];

/** Keel's code for a request it could not read. On a ruling, that would be this Worker's own mistake. */
const MALFORMED = "request.invalid";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function fields(value: unknown): Map<string, unknown> {
  return new Map<string, unknown>(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );
}

/** What a request sent, if it sent a JSON object. */
async function sentBy(request: Request): Promise<Map<string, unknown>> {
  try {
    return fields(await request.json());
  } catch {
    return new Map();
  }
}

/** Whether two secrets are the same, in time that does not depend on where they differ. */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all(
    [a, b].map(
      async (text) =>
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    ),
  );
  let difference = 0;
  for (let i = 0; i < 32; i += 1) difference |= (x?.[i] ?? 0) ^ (y?.[i] ?? 1);
  return difference === 0;
}

/** Who a request is from, by what it shows: nothing, the presenter's key, or a key that is not the presenter's. */
type Asker = "visitor" | "presenter" | "refused";

/** The presenter shows the console's own key as a bearer. A console deployed with no key has no presenter. */
async function asker(request: Request, env: Env): Promise<Asker> {
  const shown = request.headers.get("authorization");
  if (shown === null) return "visitor";
  const key = /^Bearer (.+)$/.exec(shown)?.[1] ?? "";
  if (key === "" || env.CONSOLE_PRESENTER_KEY === "") return "refused";
  return (await same(key, env.CONSOLE_PRESENTER_KEY)) ? "presenter" : "refused";
}

const unreachable = (): Response =>
  json(502, { reason: "Keel did not accept the console's credentials." });

export interface Console {
  fetch(request: Request, env: Env): Promise<Response>;
}

/** `now` gives the time in milliseconds. One of these lives as long as the isolate, and so do the tokens it holds. */
export function createConsole(now: () => number = Date.now): Console {
  const tokens = new Map<Scope, { value: string; until: number }>();

  /** A token of exactly one scope, kept until a minute before it expires. */
  async function token(env: Env, scope: Scope): Promise<string | null> {
    const held = tokens.get(scope);
    if (held !== undefined && held.until > now()) return held.value;
    const [id, secret] =
      scope === "observer"
        ? [env.KEEL_OBSERVER_CLIENT_ID, env.KEEL_OBSERVER_CLIENT_SECRET]
        : [env.KEEL_OPERATOR_CLIENT_ID, env.KEEL_OPERATOR_CLIENT_SECRET];
    const response = await env.KEEL.fetch(
      new Request(`https://${env.KEEL_API_HOST}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: id,
          client_secret: secret,
          scope,
        } satisfies TokenRequest).toString(),
      }),
    );
    if (!response.ok) return null;
    const granted = fields(await response.json().catch(() => null));
    const [value, lasts] = [
      granted.get("access_token" satisfies keyof TokenResponse),
      granted.get("expires_in" satisfies keyof TokenResponse),
    ];
    if (typeof value !== "string" || typeof lasts !== "number") return null;
    tokens.set(scope, { value, until: now() + (lasts - 60) * 1000 });
    return value;
  }

  /** Calls Keel as `scope`. A 401 means the token went stale early: it is dropped and the call made once more. */
  async function asKeel(
    env: Env,
    scope: Scope,
    build: (bearer: string) => Request,
  ): Promise<Response | null> {
    const first = await token(env, scope);
    if (first === null) return null;
    const response = await env.KEEL.fetch(build(first));
    if (response.status !== 401) return response;
    tokens.delete(scope);
    const second = await token(env, scope);
    return second === null ? null : env.KEEL.fetch(build(second));
  }

  async function read(request: Request, url: URL, env: Env): Promise<Response> {
    const allowed = READS.find((candidate) =>
      candidate.path.test(url.pathname.slice("/api".length)),
    );
    if (allowed === undefined) return json(404, { reason: "The console does not read that." });
    if (request.method !== "GET")
      return json(405, { reason: "The console only reads here." }, { allow: "GET" });
    const query = new URLSearchParams();
    for (const name of allowed.query) {
      const value = url.searchParams.get(name);
      if (value !== null) query.set(name, value);
    }
    const from = await asker(request, env);
    if (from === "refused") return json(401, { reason: "That is not the presenter's key." });
    const target = `https://${env.KEEL_API_HOST}${url.pathname.slice("/api".length)}${query.size > 0 ? `?${query.toString()}` : ""}`;
    // Nothing of the browser's request crosses but its query: not its headers, not its cookies. A visitor's
    // read carries no token, so Keel answers it as it answers anyone: for a public project, and no other.
    const response =
      from === "presenter"
        ? await asKeel(
            env,
            "observer",
            (bearer) =>
              new Request(target, {
                headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
              }),
          )
        : await env.KEEL.fetch(new Request(target, { headers: { accept: "application/json" } }));
    if (response === null) return unreachable();
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }

  async function present(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST")
      return json(405, { reason: "Ask with POST." }, { allow: "POST" });
    if ((await asker(request, env)) !== "presenter")
      return json(401, { reason: "This console is read-only." });
    const escalationId = (await sentBy(request)).get("escalationId");
    if (typeof escalationId !== "string" || escalationId === "")
      return json(400, { reason: "Name the question." });
    const expires = Math.floor(now() / 1000) + CAPABILITY_TTL;
    const nonce = [...crypto.getRandomValues(new Uint8Array(12))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return json(200, {
      capability: await mintCapability(env.CONSOLE_CAPABILITY_KEY, {
        escalationId,
        expires,
        nonce,
      }),
      expires,
    });
  }

  async function rule(request: Request, capability: string, env: Env): Promise<Response> {
    if (request.method !== "POST")
      return json(405, { reason: "Rule with POST." }, { allow: "POST" });
    const checked = await checkCapability(
      env.CONSOLE_CAPABILITY_KEY,
      capability,
      Math.floor(now() / 1000),
    );
    if (!checked.ok)
      return checked.reason === "expired"
        ? json(410, { reason: "This link has expired." })
        : json(403, { reason: "This link is not good." });
    const sent = await sentBy(request);
    const [option, rationale] = [sent.get("option"), sent.get("rationale")];
    if (typeof option !== "string" || option === "")
      return json(400, { reason: "Name the option." });
    // The operation's whole input, as Keel's contract has it: the question in the path, the capability's nonce
    // as the idempotency key, and the ruling as the body.
    const {
      escalationId,
      "idempotency-key": key,
      ...ruling
    }: Operator_giveRulingInput = {
      escalationId: checked.claim.escalationId,
      "idempotency-key": `console:${checked.claim.nonce}`,
      option,
      ...(typeof rationale === "string" ? { rationale } : {}),
    };
    // The one thing the operator's token is used for: this question, and no other route.
    const response = await asKeel(
      env,
      "operator",
      (bearer) =>
        new Request(
          `https://${env.KEEL_API_HOST}/v1/escalations/${encodeURIComponent(escalationId)}/ruling`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
              "idempotency-key": key,
            },
            body: JSON.stringify(ruling),
          },
        ),
    );
    if (response === null) return unreachable();
    if (response.ok) return json(200, { state: "ruled" });
    // Keel answers a ruling on a question already ruled, or withdrawn, with 409.
    if (response.status === 409)
      return json(409, { reason: "This question has already been answered." });
    if (response.status === 404) return json(404, { reason: "This question is not open." });
    // This Worker sends a well-formed ruling, so a 400 is Keel's domain refusing an option the question does not
    // have. The one exception is Keel's own code for a request it could not read, which would be a fault here.
    if (
      response.status === 400 &&
      fields(await response.json().catch(() => null)).get("code") !== MALFORMED
    ) {
      return json(400, { reason: "That is not one of its options." });
    }
    return json(502, { reason: "Keel did not take the ruling." });
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "keel-console" });
      if (url.pathname.startsWith("/api/")) return read(request, url, env);
      if (url.pathname === "/present/capability") return present(request, env);
      if (url.pathname.startsWith("/rule/"))
        return rule(request, decodeURIComponent(url.pathname.slice("/rule/".length)), env);
      return env.ASSETS.fetch(request);
    },
  };
}
