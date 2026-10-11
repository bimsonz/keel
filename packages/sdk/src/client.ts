import type {
  CreateProjectRequest,
  DeclareRequest,
  EnrolAgentRequest,
  ProjectSettings,
  SubmitRequest,
  TokenResponse,
  WireOutputs,
} from "@keeltown/contracts";
import { KeelProblem, KeelTokenError } from "./problem.ts";
import { type InputOf, ROUTES, type RoutedOperation } from "./routes.ts";

export interface KeelClientOptions {
  /** Keel's origin, e.g. `https://keel.example.workers.dev`; the client adds `/v1`. */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Scopes to ask for; every scope the agent holds when absent. */
  readonly scopes?: readonly string[];
  /** Defaults to the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

/** A mutating call is retried safely only under the same key; one is minted when absent. */
export interface Idempotent extends CallOptions {
  readonly idempotencyKey?: string;
}

/** A token is refreshed this long before it expires, so a call never carries one that lapses in flight. */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * Keel's API, typed from `@keeltown/contracts`. It exchanges the client
 * credentials for a bearer token, caches it until shortly before it expires,
 * and on a 401 exchanges once more and retries the call once, under the same
 * Idempotency-Key. A refusal throws `KeelProblem`, carrying the next actions.
 */
export class KeelClient {
  readonly #options: KeelClientOptions;
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  #token: { readonly value: string; readonly expiresAt: number } | undefined;

  constructor(options: KeelClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get #api(): string {
    return `${this.#options.baseUrl.replace(/\/+$/, "")}/v1`;
  }

  /** A bearer token for the client's credentials: the cached one while it is fresh. */
  async token(options: { readonly fresh?: boolean } = {}): Promise<string> {
    if (options.fresh !== true && this.#token !== undefined && Date.now() < this.#token.expiresAt)
      return this.#token.value;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#options.clientId,
      client_secret: this.#options.clientSecret,
    });
    if (this.#options.scopes !== undefined) form.set("scope", this.#options.scopes.join(" "));
    const response = await this.#fetch(`${this.#api}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const refusal = typeof body === "object" && body !== null ? body : {};
      throw new KeelTokenError(
        "error" in refusal && typeof refusal.error === "string"
          ? refusal.error
          : "invalid_response",
        response.status,
        "error_description" in refusal && typeof refusal.error_description === "string"
          ? refusal.error_description
          : undefined,
      );
    }
    if (!isTokenResponse(body)) throw new KeelTokenError("invalid_response", response.status);
    const granted = body;
    this.#token = {
      value: granted.access_token,
      expiresAt: Date.now() + granted.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return granted.access_token;
  }

  /**
   * Any routed operation by its operation id, with the input the contract
   * declares for it (path, query, header and body fields together).
   */
  async call<Op extends RoutedOperation>(
    operation: Op,
    input: InputOf<Op>,
    options: CallOptions = {},
  ): Promise<WireOutputs[Op]> {
    const request = this.#request(operation, input);
    const send = async (token: string) =>
      this.#fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    let response = await send(await this.token());
    if (response.status === 401) response = await send(await this.token({ fresh: true }));
    if (!response.ok) throw await KeelProblem.from(response);
    // The body is the contract's: Keel validates every response against the published schemas.
    // Parsed from text, because `json()` is typed `any` in DOM's lib but `unknown` in Node's.
    const answer: WireOutputs[Op] = JSON.parse(await response.text());
    return answer;
  }

  #request(operation: RoutedOperation, input: Readonly<Record<string, unknown>>) {
    const route: (typeof ROUTES)[RoutedOperation] = ROUTES[operation];
    const query = new Set<string>("query" in route ? route.query : []);
    const headerNames = new Set<string>("headers" in route ? route.headers : []);
    const params = new URLSearchParams();
    const headers: Record<string, string> = { accept: "application/json" };
    const body: Record<string, unknown> = {};
    let path: string = route.path;
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (path.includes(`{${key}}`))
        path = path.replace(`{${key}}`, encodeURIComponent(scalar(value)));
      else if (query.has(key)) params.set(key, scalar(value));
      else if (headerNames.has(key)) headers[key] = scalar(value);
      else body[key] = value;
    }
    const search = params.size > 0 ? `?${params.toString()}` : "";
    const sendsBody = route.method !== "GET";
    if (sendsBody) headers["content-type"] = "application/json";
    return {
      url: `${this.#api}${path}${search}`,
      method: route.method,
      headers,
      body: sendsBody ? JSON.stringify(body) : undefined,
    };
  }

  whoami(options?: CallOptions): Promise<WireOutputs["whoami"]> {
    return this.call("whoami", {}, options);
  }

  /** Declares a change and takes its workspace. Retry with the same key to reach the same change. */
  declare(intent: DeclareRequest, options: Idempotent = {}): Promise<WireOutputs["declare"]> {
    return this.call("declare", { ...intent, "idempotency-key": keyOf(options) }, options);
  }

  /** Submits a commit pushed to the change's workspace, under the change's lease. */
  submit(
    submission: SubmitRequest,
    options: Idempotent & { readonly lease: string },
  ): Promise<WireOutputs["submit"]> {
    return this.call(
      "submit",
      { ...submission, "keel-lease": options.lease, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Where a change's submission stands; with `wait` (0–30 s), once it moves. */
  status(
    changeId: string,
    options: CallOptions & { readonly wait?: number } = {},
  ): Promise<WireOutputs["status"]> {
    return this.call("status", { changeId, wait: options.wait }, options);
  }

  /** Notices after `cursor`; with `wait` (0–30 s), the first one to arrive. */
  inbox(
    options: CallOptions & { readonly cursor?: string; readonly wait?: number } = {},
  ): Promise<WireOutputs["inbox"]> {
    return this.call("inbox", { cursor: options.cursor, wait: options.wait }, options);
  }

  /** The operation log after `cursor`, oldest first; with `wait`, the next event. */
  events(
    options: CallOptions & {
      readonly cursor?: string;
      readonly wait?: number;
      readonly limit?: number;
    } = {},
  ): Promise<WireOutputs["Inbox_listEvents"]> {
    return this.call(
      "Inbox_listEvents",
      { cursor: options.cursor, wait: options.wait, limit: options.limit },
      options,
    );
  }

  change(changeId: string, options?: CallOptions): Promise<WireOutputs["Changes_getChange"]> {
    return this.call("Changes_getChange", { changeId }, options);
  }

  trunk(projectId: string, options?: CallOptions): Promise<WireOutputs["Views_getTrunk"]> {
    return this.call("Views_getTrunk", { projectId }, options);
  }

  /** Operator: creates a project whose trunk is forked from `source`. */
  createProject(
    project: CreateProjectRequest,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_createProject"]> {
    return this.call(
      "Operator_createProject",
      { ...project, "idempotency-key": keyOf(options) },
      options,
    );
  }

  /** Operator: a project's settings, as its Project DO holds them. */
  settings(projectId: string, options?: CallOptions): Promise<WireOutputs["Operator_getSettings"]> {
    return this.call("Operator_getSettings", { projectId }, options);
  }

  /**
   * Operator: replaces a project's settings. A PUT of what is already there
   * commits nothing, so a retry is safe; an absent `verification` means `required`.
   */
  putSettings(
    projectId: string,
    settings: ProjectSettings,
    options?: CallOptions,
  ): Promise<WireOutputs["Operator_putSettings"]> {
    return this.call("Operator_putSettings", { ...settings, projectId }, options);
  }

  /** Operator: enrols an agent. The client secret in the answer is shown once. */
  enrolAgent(
    agent: EnrolAgentRequest,
    options: Idempotent = {},
  ): Promise<WireOutputs["Operator_enrolAgent"]> {
    return this.call(
      "Operator_enrolAgent",
      { ...agent, "idempotency-key": keyOf(options) },
      options,
    );
  }
}

/** A path, query or header value: the contract makes them strings and numbers only. */
function scalar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isTokenResponse(body: unknown): body is TokenResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "access_token" in body &&
    typeof body.access_token === "string" &&
    "expires_in" in body &&
    typeof body.expires_in === "number"
  );
}

const keyOf = (options: Idempotent) => options.idempotencyKey ?? crypto.randomUUID();

export function createKeelClient(options: KeelClientOptions): KeelClient {
  return new KeelClient(options);
}
