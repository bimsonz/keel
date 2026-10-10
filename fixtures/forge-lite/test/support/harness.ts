import type { Hono } from "hono";
import { createApp } from "../../src/app.ts";
import { ManualClock } from "../../src/clock.ts";
import type { CollaboratorRole } from "../../src/domain/roles.ts";
import type { Visibility } from "../../src/domain/visibility.ts";
import type { DomainEvent } from "../../src/events.ts";
import type { AppEnv } from "../../src/http/env.ts";
import { sequentialIds } from "../../src/ids.ts";
import { MemoryStore } from "../../src/store/memory.ts";

/** 2026-01-01T09:00:00Z, where every test clock starts. */
export const START = Date.UTC(2026, 0, 1, 9, 0, 0);
export const PASSWORD = "correct horse battery staple";

/** Something that can make requests, as a signed-in user or anonymously. */
export interface Client {
  readonly username: string | undefined;
  readonly token: string | undefined;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body?: unknown): Promise<Response>;
  delete(path: string): Promise<Response>;
}

export interface Harness {
  readonly app: Hono<AppEnv>;
  readonly store: MemoryStore;
  readonly clock: ManualClock;
  /** Every event the store has emitted, in order. */
  readonly events: DomainEvent[];
  readonly anonymous: Client;
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  /** A client for `token`, whether or not it is valid. */
  client(token: string, username?: string): Client;
  signUp(username: string, password?: string): Promise<void>;
  /** Logs in and returns the bearer token. */
  login(username: string, password?: string): Promise<string>;
  /** Signs up and logs in a new user. */
  user(username: string): Promise<Client>;
  createRepo(owner: Client, name: string, visibility?: Visibility): Promise<void>;
  addCollaborator(owner: Client, repo: string, username: string, role: CollaboratorRole): Promise<void>;
}

export interface RequestOptions {
  readonly token?: string | undefined;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HarnessOptions {
  readonly store?: MemoryStore;
}

/** A fresh forge with a manual clock and sequential identifiers. */
export function harness(options: HarnessOptions = {}): Harness {
  const store = options.store ?? new MemoryStore();
  const clock = new ManualClock(START);
  const events: DomainEvent[] = [];
  store.events.subscribeAll((event) => events.push(event));
  const app = createApp({ store, clock, ids: sequentialIds() });

  const request = async (method: string, path: string, opts: RequestOptions = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    return app.request(path, init);
  };

  const makeClient = (token: string | undefined, username: string | undefined): Client => ({
    username,
    token,
    get: (path) => request("GET", path, { token }),
    post: (path, body) => request("POST", path, { token, body }),
    put: (path, body) => request("PUT", path, { token, body }),
    patch: (path, body) => request("PATCH", path, { token, body }),
    delete: (path) => request("DELETE", path, { token }),
  });

  const signUp = async (username: string, password = PASSWORD): Promise<void> => {
    await expectStatus(request("POST", "/users", { body: { username, password } }), 201, `sign up ${username}`);
  };

  const login = async (username: string, password = PASSWORD): Promise<string> => {
    const res = await expectStatus(
      request("POST", "/sessions", { body: { username, password } }),
      201,
      `log in ${username}`,
    );
    return (await json<{ token: string }>(res)).token;
  };

  return {
    app,
    store,
    clock,
    events,
    anonymous: makeClient(undefined, undefined),
    request,
    client: (token, username) => makeClient(token, username),
    signUp,
    login,
    async user(username) {
      await signUp(username);
      return makeClient(await login(username), username);
    },
    async createRepo(owner, name, visibility = "private") {
      await expectStatus(owner.post("/repos", { name, visibility }), 201, `create ${name}`);
    },
    async addCollaborator(owner, repo, username, role) {
      await expectStatus(
        owner.put(`/repos/${owner.username}/${repo}/collaborators/${username}`, { role }),
        201,
        `add ${username} to ${repo} as ${role}`,
      );
    },
  };
}

/** Parses a JSON response body. */
export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The parts of a problem+json body that every error carries. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

/** Asserts a problem+json response with the given status, and returns its body. */
export async function problem(res: Response, status: number): Promise<ProblemBody> {
  if (res.status !== status || !(res.headers.get("content-type") ?? "").startsWith("application/problem+json")) {
    throw new Error(
      `expected a ${status} problem, got ${res.status} ${res.headers.get("content-type")}: ${await res.text()}`,
    );
  }
  return json<ProblemBody>(res);
}

async function expectStatus(pending: Promise<Response>, status: number, what: string): Promise<Response> {
  const res = await pending;
  if (res.status !== status) {
    throw new Error(`setup step "${what}" answered ${res.status}, expected ${status}: ${await res.text()}`);
  }
  return res;
}
