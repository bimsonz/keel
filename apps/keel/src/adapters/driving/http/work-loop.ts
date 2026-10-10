import type { Declared, DeclareInput, SubmitInput } from "@keeltown/core/application/coordination";
import {
  type Change,
  type ChangeNotFound,
  type ChangeStateRefused,
  type CommitNotInWorkspace,
  FootprintEntry,
  type Lease,
  LEASE_TTL_MS,
  type LeaseStale,
  type PoolExhausted,
  type Preflight,
  Proposition,
  type SketchNotFound,
} from "@keeltown/core/domain/coordination";
import type { IdempotencyConflict, InboxPage } from "@keeltown/core/domain/identity";
import {
  type Anchor,
  ChangeId,
  type Citation,
  CommitSha,
  LeaseId,
  SketchId,
} from "@keeltown/core/kernel";
import type { SubmissionStatus } from "@keeltown/core/ports";
import { Result, Schema, SchemaIssue } from "effect";
import type {
  DeclareResult,
  InboxResult,
  Operations,
  StatusResult,
  SubmitResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { type NextAction, problem, type ProblemBody } from "./problems.ts";

/**
 * Pure mappers for the work loop: declare, submit, status and inbox. Wire
 * input is decoded into domain types here (a value the domain refuses is a 400
 * naming the field); domain results and every error tag map to the generated
 * result unions, exhaustively.
 */

export type Input<K extends keyof Operations<Caller>> = Parameters<Operations<Caller>[K]>[1];
type Issues = NonNullable<ProblemBody["issues"]>;

const iso = (ms: number) => new Date(ms).toISOString();
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function decodeWith<S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
): Result.Result<S["Type"], Issues> {
  return Result.mapError(Schema.decodeUnknownResult(schema)(value), (error) =>
    formatIssues(error.issue).issues.map((issue) => ({
      path: (issue.path ?? []).map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "number" ? key : String(key);
      }),
      message: issue.message,
    })),
  );
}

export function invalid(caller: Caller, issues: Issues) {
  return {
    status: 400 as const,
    body: problem(400, "request.invalid", caller.requestId, { issues }),
  };
}

type WireProposition = Input<"declare">["premises"][number];
type WireCitation = NonNullable<WireProposition["cites"]>[number];

/** The wire tags citations by `kind`; the domain by `_tag`. Decoding checks everything else. */
function citationInput(citation: WireCitation) {
  switch (citation.kind) {
    case "message":
      return { _tag: "message", session: citation.session, seq: citation.seq };
    case "anchor":
      return { _tag: "anchor", anchor: citation.anchor };
    case "record":
      return { _tag: "record", id: citation.id };
    default: {
      const unmapped: never = citation;
      return unmapped;
    }
  }
}

function propositionInput(proposition: WireProposition) {
  const { cites, ...rest } = proposition;
  return { ...rest, ...(cites === undefined ? {} : { cites: cites.map(citationInput) }) };
}

function anchorView(anchor: Anchor) {
  return {
    path: anchor.path,
    commit: anchor.commit,
    ...(anchor.symbol === undefined ? {} : { symbol: anchor.symbol }),
  };
}

function citationView(citation: Citation) {
  switch (citation._tag) {
    case "message":
      return { kind: "message" as const, session: citation.session, seq: citation.seq };
    case "anchor":
      return { kind: "anchor" as const, anchor: anchorView(citation.anchor) };
    case "record":
      return { kind: "record" as const, id: citation.id };
    default: {
      const unmapped: never = citation;
      return unmapped;
    }
  }
}

function propositionView(proposition: Proposition) {
  return {
    subject: proposition.subject,
    predicate: proposition.predicate,
    relation: proposition.relation,
    value: proposition.value,
    strength: proposition.strength ?? "must",
    ...(proposition.unit === undefined ? {} : { unit: proposition.unit }),
    ...(proposition.scope === undefined ? {} : { scope: proposition.scope }),
    ...(proposition.gloss === undefined ? {} : { gloss: proposition.gloss }),
    ...(proposition.anchors === undefined ? {} : { anchors: proposition.anchors.map(anchorView) }),
    ...(proposition.cites === undefined ? {} : { cites: proposition.cites.map(citationView) }),
  };
}

function footprintView(entry: FootprintEntry) {
  return {
    path: entry.path,
    op: entry.op,
    ...(entry.symbol === undefined ? {} : { symbol: entry.symbol }),
  };
}

const DeclareFields = Schema.Struct({
  goal: Schema.NonEmptyString,
  footprint: Schema.Array(FootprintEntry),
  premises: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
  fromSketch: Schema.optional(SketchId),
});

export function declareInput(input: Input<"declare">): Result.Result<DeclareInput, Issues> {
  const wire = {
    goal: input.goal,
    footprint: input.footprint ?? [],
    premises: input.premises.map(propositionInput),
    ...(input.declaredEffects === undefined
      ? {}
      : { declaredEffects: input.declaredEffects.map(propositionInput) }),
    ...(input.fromSketch === undefined ? {} : { fromSketch: input.fromSketch }),
  };
  return Result.map(decodeWith(DeclareFields, wire), (fields) => ({
    goal: fields.goal,
    footprint: fields.footprint,
    premises: fields.premises,
    ...(fields.declaredEffects === undefined ? {} : { declaredEffects: fields.declaredEffects }),
    ...(fields.fromSketch === undefined ? {} : { fromSketch: fields.fromSketch }),
    idempotencyKey: input["idempotency-key"],
  }));
}

const SubmitFields = Schema.Struct({ changeId: ChangeId, lease: LeaseId, commitSha: CommitSha });

export function submitInput(input: Input<"submit">): Result.Result<SubmitInput, Issues> {
  return Result.map(
    decodeWith(SubmitFields, {
      changeId: input.changeId,
      lease: input["keel-lease"],
      commitSha: input.commitSha,
    }),
    (fields) => ({ ...fields, idempotencyKey: input["idempotency-key"] }),
  );
}

export function changeIdInput(changeId: string): Result.Result<ChangeId, Issues> {
  return Result.mapError(decodeWith(ChangeId, changeId), (issues) =>
    issues.map((issue) => ({ ...issue, path: ["changeId", ...issue.path] })),
  );
}

function envelope<R>(summary: string, result: R, next: readonly NextAction[] = []) {
  return { ok: true, summary, result, findings: [], next: [...next], notices: [], cost: {} };
}

function changeView(change: Change) {
  return {
    id: change.id,
    agentId: change.agentId,
    state: change.state,
    revision: change.intent.revision,
    goal: change.intent.goal,
    footprint: change.intent.footprint.map(footprintView),
    premises: change.intent.premises.map(propositionView),
    createdAt: iso(change.createdAt),
  };
}

function leaseView(lease: Lease) {
  return {
    id: lease.id,
    renewedAt: iso(lease.renewedAt),
    lapsesAt: iso(lease.renewedAt + LEASE_TTL_MS),
  };
}

function preflightView(preflight: Preflight) {
  return {
    neighbours: preflight.neighbours.map((n) => ({ ...n, subjects: [...n.subjects] })),
    contradictions: preflight.contradictions.map((c) => ({
      premise: propositionView(c.premise),
      with: propositionView(c.with),
      holder: c.holder,
    })),
    precedents: preflight.precedents.map((p) => ({
      decisionId: p.decisionId,
      summary: p.summary,
      decidedAt: iso(p.decidedAt),
      ...(p.scope === undefined ? {} : { scope: p.scope }),
    })),
    suggestedMove: preflight.suggestedMove,
  };
}

const statusOf = (changeId: ChangeId): NextAction => ({
  kind: "read",
  title: "Wait for the change's submission to move",
  operationId: "status",
  args: { changeId, wait: 30 },
});

export function declareOk(declared: Declared): DeclareResult {
  const { change, preflight, workspace } = declared;
  return {
    status: 201,
    body: envelope(
      `Declared ${change.id} (${change.state}). Push your commits to the workspace remote with its token, then submit.`,
      {
        change: changeView(change),
        preflight: preflightView(preflight),
        workspace: {
          id: workspace.workspaceId,
          remote: workspace.remote,
          token: workspace.token,
          expiresAt: iso(workspace.expiresAt),
        },
        lease: leaseView(change.lease),
      },
      [
        {
          kind: "call",
          title: "Submit a commit once it is pushed to the workspace",
          operationId: "submit",
          args: { changeId: change.id },
        },
      ],
    ),
  };
}

export function declareError(
  caller: Caller,
  error: PoolExhausted | SketchNotFound | IdempotencyConflict,
): DeclareResult {
  switch (error._tag) {
    case "PoolExhausted":
      return {
        status: 503,
        headers: { "retry-after": Math.ceil(error.retryAfterMs / 1000) },
        body: problem(503, "workspace.pool_exhausted", caller.requestId, {
          detail: "Every workspace is taken or still forking.",
          retryAfterMs: error.retryAfterMs,
          nextActions: [
            {
              kind: "wait",
              title: "Declare again with the same Idempotency-Key after retryAfterMs",
              operationId: "declare",
            },
          ],
        }),
      };
    case "SketchNotFound":
      return {
        status: 404,
        body: problem(404, "sketch.not_found", caller.requestId, {
          detail: `No sketch ${error.sketchId}.`,
          nextActions: [
            { kind: "call", title: "Declare without fromSketch", operationId: "declare" },
          ],
        }),
      };
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} was used for a different declaration.`,
          nextActions: [
            { kind: "call", title: "Declare with a fresh Idempotency-Key", operationId: "declare" },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

function submissionView(change: Change, commitSha: CommitSha) {
  return {
    changeId: change.id,
    revision: change.intent.revision,
    commitSha,
    state: change.state,
  };
}

export function submitOk(change: Change, commitSha: CommitSha): SubmitResult {
  return {
    status: 202,
    headers: { location: `/v1/changes/${change.id}/submission` },
    body: envelope(
      `Submitted ${commitSha.slice(0, 12)} for ${change.id}; Keel is verifying it.`,
      submissionView(change, commitSha),
      [statusOf(change.id)],
    ),
  };
}

function changeNotFound(caller: Caller, error: ChangeNotFound) {
  return {
    status: 404 as const,
    body: problem(404, "change.not_found", caller.requestId, {
      detail: `No change ${error.changeId}.`,
      nextActions: [{ kind: "call", title: "Declare the change first", operationId: "declare" }],
    }),
  };
}

export function submitError(
  caller: Caller,
  error: ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace,
): SubmitResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "LeaseStale":
      return {
        status: 409,
        body: problem(409, "change.lease_stale", caller.requestId, {
          detail: `Lease ${error.leaseId} is not the active lease on ${error.changeId}.`,
          nextActions: [
            {
              kind: "read",
              title: "Read the change to see who holds its lease now",
              operationId: "Changes_getChange",
              args: { changeId: error.changeId },
            },
          ],
        }),
      };
    case "ChangeStateRefused":
      return {
        status: 409,
        body: problem(409, "change.state_refused", caller.requestId, {
          detail: `${error.changeId} is ${error.state}, where ${error.command} is not allowed.`,
          nextActions: [statusOf(error.changeId)],
        }),
      };
    case "CommitNotInWorkspace":
      return {
        status: 409,
        body: problem(409, "change.commit_not_in_workspace", caller.requestId, {
          detail: `${error.commitSha} is not in ${error.changeId}'s workspace.`,
          nextActions: [
            {
              kind: "call",
              title: "Push the commit to the change's workspace, then submit it again",
              operationId: "submit",
              args: { changeId: error.changeId, commitSha: error.commitSha },
            },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function statusOk(caller: Caller, status: SubmissionStatus): StatusResult {
  const { change, commitSha } = status;
  if (commitSha === null) {
    return {
      status: 404,
      body: problem(404, "resource.not_found", caller.requestId, {
        detail: `${change.id} has no submission yet; it is ${change.state}.`,
        nextActions: [
          {
            kind: "call",
            title: "Submit a commit pushed to the change's workspace",
            operationId: "submit",
            args: { changeId: change.id },
          },
        ],
      }),
    };
  }
  const next: readonly NextAction[] =
    change.state === "bounced"
      ? [
          {
            kind: "call",
            title: "Fix what bounced it, push, and submit again",
            operationId: "submit",
            args: { changeId: change.id },
          },
        ]
      : change.state === "landed" || change.state === "withdrawn" || change.state === "superseded"
        ? []
        : [statusOf(change.id)];
  return {
    status: 200,
    body: envelope(
      `${change.id} is ${change.state} at ${commitSha.slice(0, 12)}.`,
      submissionView(change, commitSha),
      next,
    ),
  };
}

export function statusError(caller: Caller, error: ChangeNotFound): StatusResult {
  return changeNotFound(caller, error);
}

export function inboxOk(page: InboxPage): InboxResult {
  return {
    status: 200,
    body: envelope(
      page.notices.length === 0
        ? "Nothing new."
        : `${page.notices.length} new notice${page.notices.length === 1 ? "" : "s"}.`,
      {
        notices: page.notices.map((notice) => ({
          id: notice.id,
          at: iso(notice.at),
          kind: notice.kind,
          title: notice.title,
          ...(notice.detail === undefined ? {} : { detail: notice.detail }),
          ...(notice.ref === undefined ? {} : { ref: notice.ref }),
        })),
        cursor: page.cursor,
      },
      [
        {
          kind: "read",
          title: "Wait for the next notice",
          operationId: "inbox",
          args: { cursor: page.cursor, wait: 30 },
        },
      ],
    ),
  };
}
