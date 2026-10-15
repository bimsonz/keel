import type { NextAction } from "@keeltown/contracts";

/** One reason a request was refused, pointing at the field. */
export interface ProblemIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** The body of every Keel error: RFC 9457 problem details plus Keel's fields. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly requestId: string;
  readonly nextActions: readonly NextAction[];
  readonly issues?: readonly ProblemIssue[];
  readonly conflict?: string;
  readonly retryAfterMs?: number;
}

function isProblem(value: unknown): value is ProblemBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "status" in value &&
    typeof value.status === "number" &&
    "nextActions" in value &&
    Array.isArray(value.nextActions)
  );
}

/**
 * Keel refused the request. `code` says why, and `nextActions` says what to
 * do: each names the operation to call next, ready to feed back in.
 */
export class KeelProblem extends Error {
  override readonly name = "KeelProblem";
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly nextActions: readonly NextAction[];
  readonly issues: readonly ProblemIssue[];
  readonly retryAfterMs: number | undefined;
  readonly body: ProblemBody;

  constructor(body: ProblemBody) {
    super(`${body.code}: ${body.detail ?? body.title}`);
    this.status = body.status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.nextActions = body.nextActions;
    this.issues = body.issues ?? [];
    this.retryAfterMs = body.retryAfterMs;
    this.body = body;
  }

  /**
   * The problem in a response, or a stand-in when the body is not one (a
   * proxy's page, say). A wait the body does not name is read from the
   * `Retry-After` header, in seconds.
   */
  static async from(response: Response): Promise<KeelProblem> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const seconds = Number(response.headers.get("retry-after") ?? "");
    const wait =
      response.headers.has("retry-after") && Number.isFinite(seconds) && seconds >= 0
        ? { retryAfterMs: seconds * 1000 }
        : {};
    if (isProblem(parsed)) return new KeelProblem({ ...wait, ...parsed });
    return new KeelProblem({
      type: "about:blank",
      title: response.statusText || "Unexpected response",
      status: response.status,
      code: "http.unexpected",
      detail: text.slice(0, 500),
      requestId: response.headers.get("x-request-id") ?? "",
      nextActions: [],
      ...wait,
    });
  }
}

/**
 * The token endpoint refused the credentials (RFC 6749 § 5.2). Its message is
 * Keel's own description when it gave one, which says why in words; the
 * protocol's code stays on `error`.
 */
export class KeelTokenError extends Error {
  override readonly name = "KeelTokenError";
  readonly error: string;
  readonly status: number;
  readonly description: string | undefined;

  constructor(error: string, status: number, description?: string) {
    super(description ?? `token exchange refused: ${error}`);
    this.error = error;
    this.status = status;
    this.description = description;
  }
}
