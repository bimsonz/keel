import type {
  AbandonCall,
  Adopted,
  AdoptInput,
  Declared,
  DeclareInput,
  LeaseRequired,
  CommitInput,
  CommitParentRefused,
  CommittedChange,
  RebasedChange,
  RebaseInput,
  RelyInput,
  ResolveInput,
  ReviseInput,
  Revised,
  SubmitInput,
} from "@keeltown/core/application/coordination";
import type { PushRejected } from "@keeltown/core/domain/integration";
import {
  type Change,
  type ChangeInOtherProject,
  type ChangeNotFound,
  type ChangeStateRefused,
  type CommitNotInWorkspace,
  FootprintEntry,
  type Lease,
  LEASE_TTL_MS,
  type LeaseNotLapsed,
  type LeaseStale,
  type PoolExhausted,
  type Preflight,
  Move,
  Proposition,
  type RevisionMismatch,
} from "@keeltown/core/domain/coordination";
import type { IdempotencyConflict, InboxPage } from "@keeltown/core/domain/identity";
import type { ConflictNotFound, MoveRefused } from "@keeltown/core/domain/verification";
import {
  type Anchor,
  ChangeId,
  type NextAction as DomainNextAction,
  type Citation,
  CommitSha,
  ConflictId,
  LeaseId,
} from "@keeltown/core/kernel";
import type {
  ConflictView,
  EditsRefused,
  ObjectNotFound,
  PackTooLarge,
  Remedy,
  SubmissionStatus,
  WorkspaceEdit,
  WorkspaceHeadMoved,
} from "@keeltown/core/ports";
import { Result, Schema, SchemaIssue } from "effect";
import type {
  AbandonResult,
  AdoptResult,
  ChangeResult,
  DeclareResult,
  InboxResult,
  NearbyResult,
  Operations,
  CommitResult,
  RebaseResult,
  RelyResult,
  ResolveResult,
  ReviseResult,
  StatusResult,
  SubmitResult,
} from "../../../generated/http/app.gen.ts";
import { noticeView } from "../notices.ts";
import type { Caller } from "./caller.ts";
import { runView } from "./mappers.ts";
import { type NextAction, problem, type ProblemBody } from "./problems.ts";

/**
 * Pure mappers for the work loop: declare, submit, adopt, abandon, status and inbox. Wire
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
});

export function declareInput(input: Input<"declare">): Result.Result<DeclareInput, Issues> {
  const wire = {
    goal: input.goal,
    footprint: input.footprint ?? [],
    premises: input.premises.map(propositionInput),
    ...(input.declaredEffects === undefined
      ? {}
      : { declaredEffects: input.declaredEffects.map(propositionInput) }),
  };
  return Result.map(decodeWith(DeclareFields, wire), (fields) => ({
    goal: fields.goal,
    footprint: fields.footprint,
    premises: fields.premises,
    ...(fields.declaredEffects === undefined ? {} : { declaredEffects: fields.declaredEffects }),
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
    ...(change.intent.declaredEffects === undefined
      ? {}
      : { declaredEffects: change.intent.declaredEffects.map(propositionView) }),
    ...(change.commitSha === undefined ? {} : { commitSha: change.commitSha }),
    ...(change.run === undefined ? {} : { run: runView(change.run) }),
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
      ...(c.withRole === undefined ? {} : { withRole: c.withRole }),
    })),
    precedents: preflight.precedents.map((p) => ({
      decisionId: p.decisionId,
      summary: p.summary,
      decidedAt: iso(p.decidedAt),
      ...(p.scope === undefined ? {} : { scope: p.scope }),
    })),
    suggestedMove: preflight.suggestedMove,
    ...(preflight.basis === undefined ? {} : { basis: preflight.basis }),
    ...(preflight.alternatives === undefined ? {} : { alternatives: [...preflight.alternatives] }),
  };
}

const statusOf = (changeId: ChangeId): NextAction => ({
  kind: "read",
  title: "Wait for the change's submission to move",
  operationId: "status",
  args: { changeId, wait: 30 },
});

/** A parked change whose lease lapsed waits for an agent to take it back. */
const adoptOf = (changeId: ChangeId): NextAction => ({
  kind: "call",
  title: "Adopt the change: its lease lapsed, so take it back with a fresh lease",
  operationId: "adopt",
  args: { changeId },
});

/** A change parked on an escalation waits for a person's ruling, which arrives in the inbox. */
const rulingOf = (change: Change): NextAction => ({
  kind: "read",
  title: `Wait in your inbox for the ruling on ${change.escalationId ?? "its escalation"}`,
  operationId: "inbox",
  args: { wait: 30 },
});

/** The domain's next actions as the API declares them, absent fields left out. */
export const apiActions = (actions: readonly DomainNextAction[]): NextAction[] =>
  actions.map(({ operationId, args, ...action }) => ({
    ...action,
    ...(operationId === undefined ? {} : { operationId }),
    ...(args === undefined ? {} : { args }),
  }));

/** The envelope's `next` holds at most three. */
const MAX_NEXT = 3;

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
  error: PoolExhausted | IdempotencyConflict,
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

/**
 * A change that is not there, with the way forward. The policy answers a
 * change the caller may not see with this too (`refusalResult`), so the two
 * read alike.
 */
export function changeNotFound(
  caller: Pick<Caller, "requestId">,
  error: { readonly changeId: string },
) {
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
  error:
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | CommitNotInWorkspace
    | IdempotencyConflict,
): SubmitResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "LeaseStale":
      return leaseStale(caller, error);
    case "ChangeStateRefused":
      return stateRefused(caller, error);
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
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} was used for a different request.`,
          nextActions: [
            { kind: "call", title: "Submit with a fresh Idempotency-Key", operationId: "submit" },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

const LeasedFields = Schema.Struct({ changeId: ChangeId, lease: LeaseId });

export function rebaseInput(input: Input<"rebase">): Result.Result<RebaseInput, Issues> {
  return Result.map(
    decodeWith(LeasedFields, { changeId: input.changeId, lease: input["keel-lease"] }),
    (fields) => ({ ...fields, idempotencyKey: input["idempotency-key"] }),
  );
}

export function rebaseOk(rebased: RebasedChange): RebaseResult {
  const { change, ref, base } = rebased;
  return {
    status: 200,
    body: envelope(
      `Rebased ${change.id} onto trunk ${base.slice(0, 12)}, now on your workspace's keel/trunk. Merge it, resolve, push, then submit.`,
      { change: changeView(change), ref, base },
      [
        {
          kind: "call",
          title:
            "Run git fetch origin keel/trunk && git merge FETCH_HEAD, resolve any conflicts, push, then submit",
          operationId: "submit",
          args: { changeId: change.id },
        },
      ],
    ),
  };
}

export function rebaseError(
  caller: Caller,
  error:
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | IdempotencyConflict
    | PushRejected
    | PackTooLarge,
): RebaseResult {
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
              operationId: "change",
              args: { changeId: error.changeId },
            },
          ],
        }),
      };
    case "ChangeStateRefused":
      return {
        status: 409,
        body: problem(409, "change.state_refused", caller.requestId, {
          detail: `${error.changeId} is ${error.state}, where a rebase is not allowed: it rebases while working or bounced, and onto a trunk head it is not already on.`,
          nextActions: [statusOf(error.changeId)],
        }),
      };
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} was used for a different request.`,
          nextActions: [
            { kind: "call", title: "Rebase with a fresh Idempotency-Key", operationId: "rebase" },
          ],
        }),
      };
    case "PushRejected":
      return {
        status: 503,
        headers: { "retry-after": 5 },
        body: problem(503, "workspace.busy", caller.requestId, {
          detail: `Trunk could not be put on the workspace's keel/trunk (${error.reason}); nothing moved.`,
          nextActions: [
            { kind: "call", title: "Rebase again in a few seconds", operationId: "rebase" },
          ],
        }),
      };
    case "PackTooLarge":
      return {
        status: 409,
        body: problem(409, "workspace.pack_too_large", caller.requestId, {
          detail: `Trunk's history since the change's base is ${error.bytes} bytes, over the ${error.limit}-byte relay limit; nothing moved.`,
          nextActions: [
            { kind: "escalate", title: "Ask an operator to move this change onto trunk by hand" },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

const CommitFields = Schema.Struct({
  changeId: ChangeId,
  lease: LeaseId,
  expectedHead: CommitSha,
  parent: Schema.optional(CommitSha),
});

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Base64 text as bytes, or undefined when it is not base64. */
function fromBase64(text: string): Uint8Array | undefined {
  if (!BASE64.test(text)) return undefined;
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** One edit as the writer takes it: exactly one of content and delete, with content decoded. */
function editOf(
  edit: Input<"commit">["edits"][number],
  at: number,
): Result.Result<WorkspaceEdit, Issues> {
  const path = ["edits", at];
  if ((edit.content === undefined) === (edit.delete === undefined))
    return Result.fail([{ path, message: "Set exactly one of content and delete" }]);
  if (edit.content === undefined) {
    if (edit.encoding !== undefined || edit.executable !== undefined)
      return Result.fail([{ path, message: "A delete carries no encoding or executable flag" }]);
    return Result.succeed({ path: edit.path, delete: true });
  }
  const content =
    edit.encoding === "base64" ? fromBase64(edit.content) : new TextEncoder().encode(edit.content);
  if (content === undefined)
    return Result.fail([{ path: [...path, "content"], message: "Not valid base64" }]);
  return Result.succeed({
    path: edit.path,
    content,
    ...(edit.executable === undefined ? {} : { executable: edit.executable }),
  });
}

export function commitInput(input: Input<"commit">): Result.Result<CommitInput, Issues> {
  const fields = decodeWith(CommitFields, {
    changeId: input.changeId,
    lease: input["keel-lease"],
    expectedHead: input.expectedHead,
    ...(input.parent === undefined ? {} : { parent: input.parent }),
  });
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  const edits: WorkspaceEdit[] = [];
  const issues: Issues[number][] = [];
  for (const [at, edit] of input.edits.entries()) {
    const decoded = editOf(edit, at);
    if (Result.isFailure(decoded)) issues.push(...decoded.failure);
    else edits.push(decoded.success);
  }
  if (issues.length > 0) return Result.fail(issues);
  const { parent, ...heads } = fields.success;
  return Result.succeed({
    ...heads,
    ...(parent === undefined ? {} : { parent }),
    edits,
    message: input.message,
    idempotencyKey: input["idempotency-key"],
  });
}

export function committedOk(committed: CommittedChange): CommitResult {
  const { change, commit, parent } = committed;
  return {
    status: 200,
    body: envelope(
      `Committed ${commit.changed} path(s) to ${change.id}'s workspace as ${commit.commitSha.slice(0, 12)}. Submit it when the change is ready.`,
      {
        change: changeView(change),
        commitSha: commit.commitSha,
        parent,
        tree: commit.tree,
        changed: commit.changed,
      },
      [
        {
          kind: "call",
          title: "Submit this commit",
          operationId: "submit",
          args: { changeId: change.id, commitSha: commit.commitSha },
        },
      ],
    ),
  };
}

/** Refusals of an edit that no repo state could make apply: the request itself is wrong. */
const MALFORMED_EDITS: ReadonlySet<EditsRefused["reason"]> = new Set([
  "bad-path",
  "duplicate-path",
  "nested-paths",
]);

export function commitEditsError(
  caller: Caller,
  error:
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | CommitParentRefused
    | WorkspaceHeadMoved
    | EditsRefused
    | ObjectNotFound
    | PackTooLarge,
): CommitResult {
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
              operationId: "change",
              args: { changeId: error.changeId },
            },
          ],
        }),
      };
    case "ChangeStateRefused":
      return {
        status: 409,
        body: problem(409, "change.state_refused", caller.requestId, {
          detail: `${error.changeId} is ${error.state}, where a commit is not allowed: it commits while working or bounced.`,
          nextActions: [statusOf(error.changeId)],
        }),
      };
    case "CommitParentRefused":
      return {
        status: 400,
        body: problem(400, "commit.parent_refused", caller.requestId, {
          detail: `A commit builds on your workspace's head (${error.expectedHead})${error.base === undefined ? "" : ` or your change's base (${error.base})`}, never on ${error.parent}.`,
          nextActions: [
            {
              kind: "call",
              title: "Commit again with no parent, or with the change's base after a rebase",
              operationId: "commit",
            },
          ],
        }),
      };
    case "WorkspaceHeadMoved":
      return {
        status: 409,
        body: problem(409, "workspace.head_moved", caller.requestId, {
          detail:
            error.head === null
              ? `Your workspace's main is not at ${error.expected}: it has no main now. Nothing was written.`
              : `Your workspace's main moved from ${error.expected} to ${error.head} since you read it. Nothing was written.`,
          nextActions: [
            {
              kind: "call",
              title:
                error.head === null
                  ? "Read the change, then commit again"
                  : `Commit again with expectedHead ${error.head}, after reading what it holds`,
              operationId: "commit",
            },
          ],
        }),
      };
    case "EditsRefused": {
      const malformed = MALFORMED_EDITS.has(error.reason);
      const status = malformed ? 400 : 409;
      return {
        status,
        body: problem(
          status,
          malformed ? "commit.bad_edits" : "commit.edits_refused",
          caller.requestId,
          {
            detail:
              error.reason === "nothing-changed"
                ? "These edits leave every file as it is: there is nothing to commit."
                : `The edit at ${error.path} cannot apply (${error.reason}). Nothing was written.`,
            nextActions: [
              { kind: "call", title: "Fix the edits and commit again", operationId: "commit" },
            ],
          },
        ),
      };
    }
    case "ObjectNotFound":
      return {
        status: 404,
        body: problem(404, "commit.parent_not_found", caller.requestId, {
          detail: `Your workspace holds no commit ${error.oid} to build on.`,
          nextActions: [
            {
              kind: "read",
              title: "Read the change for its base, and commit on it",
              operationId: "change",
            },
          ],
        }),
      };
    case "PackTooLarge":
      return {
        status: 409,
        body: problem(409, "workspace.pack_too_large", caller.requestId, {
          detail: `The commit is ${error.bytes} bytes, over the ${error.limit}-byte push limit. Nothing was written.`,
          nextActions: [
            { kind: "call", title: "Commit the edits in smaller parts", operationId: "commit" },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * The revision an If-Match names: the strong tag `"<n>"`, or the bare `n` an
 * MCP agent passes, read from the change's `revision`. A weak tag never
 * matches under RFC 9110's strong comparison, so it is refused with the rest.
 */
const IF_MATCH = /^(?:"([1-9][0-9]{0,8})"|([1-9][0-9]{0,8}))$/;

function ifMatchInput(value: string): Result.Result<number, Issues> {
  const matched = IF_MATCH.exec(value.trim());
  const digits = matched?.[1] ?? matched?.[2];
  return digits === undefined
    ? Result.fail([
        {
          path: ["if-match"],
          message:
            'Send the revision you last read as "<n>" or n (the change\'s `revision`); a weak tag never matches',
        },
      ])
    : Result.succeed(Number(digits));
}

const ReviseFields = Schema.Struct({
  changeId: ChangeId,
  lease: LeaseId,
  goal: Schema.optional(Schema.NonEmptyString),
  footprint: Schema.optional(Schema.Array(FootprintEntry)),
  premisesAdded: Schema.Array(Proposition),
  premisesRetracted: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
});

export function reviseInput(input: Input<"revise">): Result.Result<ReviseInput, Issues> {
  const fields = decodeWith(ReviseFields, {
    changeId: input.changeId,
    lease: input["keel-lease"],
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.footprint === undefined ? {} : { footprint: input.footprint }),
    premisesAdded: (input.premisesAdded ?? []).map(propositionInput),
    premisesRetracted: (input.premisesRetracted ?? []).map(propositionInput),
    ...(input.declaredEffects === undefined
      ? {}
      : { declaredEffects: input.declaredEffects.map(propositionInput) }),
  });
  const revision = ifMatchInput(input["if-match"]);
  if (Result.isFailure(fields) || Result.isFailure(revision))
    return Result.fail([
      ...(Result.isFailure(fields) ? fields.failure : []),
      ...(Result.isFailure(revision) ? revision.failure : []),
    ]);
  const { goal, footprint, declaredEffects, ...rest } = fields.success;
  return Result.succeed({
    ...rest,
    ifMatchRevision: revision.success,
    ...(goal === undefined ? {} : { goal }),
    ...(footprint === undefined ? {} : { footprint }),
    ...(declaredEffects === undefined ? {} : { declaredEffects }),
    idempotencyKey: input["idempotency-key"],
  });
}

/** What a revision or a rely leaves: the change at its new revision, and the preflight of its intent now. */
function revisedBody(verb: string, revised: Revised) {
  const { change, preflight } = revised;
  const found = preflight.contradictions.length;
  return envelope(
    `${verb} ${change.id}, now at revision ${change.intent.revision}.` +
      (found === 0
        ? ""
        : ` Preflight found ${found} contradiction${found === 1 ? "" : "s"} with another change: refine before you build on it.`),
    { change: changeView(change), preflight: preflightView(preflight) },
    [
      {
        kind: "call",
        title: "Submit a commit once it is pushed to the workspace",
        operationId: "submit",
        args: { changeId: change.id },
      },
    ],
  );
}

export function reviseOk(revised: Revised): ReviseResult {
  return { status: 200, body: revisedBody("Revised", revised) };
}

function leaseStale(caller: Caller, error: LeaseStale) {
  return {
    status: 409 as const,
    body: problem(409, "change.lease_stale", caller.requestId, {
      detail: `Lease ${error.leaseId} is not the active lease on ${error.changeId}.`,
      nextActions: [
        {
          kind: "read",
          title: "Read the change to see who holds its lease now",
          operationId: "change",
          args: { changeId: error.changeId },
        },
      ],
    }),
  };
}

export function reusedKey(
  caller: { readonly requestId: string },
  error: IdempotencyConflict,
  operationId: string,
  verb: string,
) {
  return {
    status: 409 as const,
    body: problem(409, "request.idempotency_conflict", caller.requestId, {
      detail: `Idempotency-Key ${error.idempotencyKey} was used for a different request.`,
      nextActions: [{ kind: "call", title: `${verb} with a fresh Idempotency-Key`, operationId }],
    }),
  };
}

function stateRefused(caller: Caller, error: ChangeStateRefused) {
  return {
    status: 409 as const,
    body: problem(409, "change.state_refused", caller.requestId, {
      detail: `${error.changeId} is ${error.state}, where ${error.command} is not allowed.`,
      nextActions: [statusOf(error.changeId)],
    }),
  };
}

export function reviseError(
  caller: Caller,
  error: ChangeNotFound | LeaseStale | RevisionMismatch | ChangeStateRefused | IdempotencyConflict,
): ReviseResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "LeaseStale":
      return leaseStale(caller, error);
    case "RevisionMismatch":
      return {
        status: 412,
        body: problem(412, "change.revision_mismatch", caller.requestId, {
          detail: `If-Match named revision ${error.expected}, but ${error.changeId} is at revision ${error.actual}.`,
          nextActions: [
            statusOf(error.changeId),
            {
              kind: "call",
              title: `Once you have read what changed, revise again with If-Match "${error.actual}"`,
              operationId: "revise",
              args: { changeId: error.changeId, "if-match": `"${error.actual}"` },
            },
          ],
        }),
      };
    case "ChangeStateRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return reusedKey(caller, error, "revise", "Revise");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

const RelyFields = Schema.Struct({ changeId: ChangeId, lease: LeaseId, premise: Proposition });

export function relyInput(input: Input<"rely">): Result.Result<RelyInput, Issues> {
  return Result.map(
    decodeWith(RelyFields, {
      changeId: input.changeId,
      lease: input["keel-lease"],
      premise: propositionInput(input.premise),
    }),
    (fields) => ({ ...fields, idempotencyKey: input["idempotency-key"] }),
  );
}

export function relyOk(relied: Revised): RelyResult {
  return { status: 200, body: revisedBody("Added the premise to", relied) };
}

export function relyError(
  caller: Caller,
  error: ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict,
): RelyResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "LeaseStale":
      return leaseStale(caller, error);
    case "ChangeStateRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return reusedKey(caller, error, "rely", "Rely");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** A change read by id: the change itself, bare, as the spec's `Change`. */
export function changeOk(change: Change): ChangeResult {
  return { status: 200, body: changeView(change) };
}

export function changeReadError(caller: Caller, error: ChangeNotFound): ChangeResult {
  return changeNotFound(caller, error);
}

export function nearbyOk(changeId: ChangeId, preflight: Preflight): NearbyResult {
  const found = preflight.contradictions.length;
  return {
    status: 200,
    body: envelope(
      `${preflight.neighbours.length} change${preflight.neighbours.length === 1 ? "" : "s"} near ${changeId}, ${found} contradiction${found === 1 ? "" : "s"}.`,
      { preflight: preflightView(preflight) },
    ),
  };
}

export function nearbyError(
  caller: Caller,
  error: ChangeNotFound | ChangeInOtherProject,
): NearbyResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "ChangeInOtherProject":
      return {
        status: 403,
        body: problem(403, "auth.forbidden", caller.requestId, {
          detail: `Refused: foreign-project. ${error.changeId} is in another project; your token is bound to your own.`,
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function adoptInput(input: Input<"adopt">): Result.Result<AdoptInput, Issues> {
  return Result.map(changeIdInput(input.changeId), (changeId) => ({
    changeId,
    idempotencyKey: input["idempotency-key"],
  }));
}

export function adoptOk(adopted: Adopted): AdoptResult {
  const { change, workspace } = adopted;
  return {
    status: 200,
    body: envelope(
      `Adopted ${change.id} (${change.state}) under a new lease. Pull its workspace, carry on, then submit.`,
      {
        change: changeView(change),
        lease: leaseView(change.lease),
        ...(workspace === undefined
          ? {}
          : {
              workspace: {
                id: workspace.workspaceId,
                remote: workspace.remote,
                token: workspace.token,
                expiresAt: iso(workspace.expiresAt),
              },
            }),
      },
      [statusOf(change.id)],
    ),
  };
}

export function adoptError(
  caller: Caller,
  error:
    | ChangeNotFound
    | ChangeStateRefused
    | LeaseNotLapsed
    | ChangeInOtherProject
    | IdempotencyConflict,
): AdoptResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "ChangeStateRefused":
      return stateRefused(caller, error);
    case "LeaseNotLapsed":
      return {
        status: 409,
        body: problem(409, "change.lease_not_lapsed", caller.requestId, {
          detail: `${error.changeId}'s lease lapses at ${iso(error.lapsesAt)}; it can be adopted after that.`,
          nextActions: apiActions(error.nextActions),
        }),
      };
    case "ChangeInOtherProject":
      return {
        status: 403,
        body: problem(403, "auth.forbidden", caller.requestId, {
          detail: `Refused: foreign-project. ${error.changeId} is in another project; your token is bound to your own.`,
        }),
      };
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} was used for a different request.`,
          nextActions: [
            { kind: "call", title: "Adopt with a fresh Idempotency-Key", operationId: "adopt" },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * What the agent does next about a change, by its state. A bounce's own
 * remedy, verbatim; a park on a lapsed lease is adopt and then that remedy,
 * since the lapse changes who acts, not what to do; a park on an escalation
 * waits for the ruling. Only a change the platform is moving waits on its submission.
 */
function nextFor(change: Change, remedy: Remedy | undefined): NextAction[] {
  const asked = apiActions(remedy?.nextActions ?? []);
  switch (change.state) {
    case "bounced":
      return asked.length > 0
        ? asked
        : [
            {
              kind: "call",
              title: "Fix what bounced it, push, and submit again",
              operationId: "submit",
              args: { changeId: change.id },
            },
          ];
    case "parked":
      return change.parkReason === "awaiting-ruling"
        ? [rulingOf(change)]
        : [adoptOf(change.id), ...asked].slice(0, MAX_NEXT);
    case "landed":
    case "withdrawn":
    case "superseded":
      return [];
    default:
      return [statusOf(change.id)];
  }
}

const AbandonFields = Schema.Struct({ changeId: ChangeId, lease: Schema.optionalKey(LeaseId) });

export function abandonInput(input: Input<"abandon">): Result.Result<AbandonCall, Issues> {
  const lease = input["keel-lease"];
  return Result.map(
    decodeWith(AbandonFields, {
      changeId: input.changeId,
      ...(lease === undefined ? {} : { lease }),
    }),
    (fields) => ({
      ...fields,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      idempotencyKey: input["idempotency-key"],
    }),
  );
}

export function abandonOk(change: Change): AbandonResult {
  return {
    status: 200,
    body: envelope(`Withdrew ${change.id}; its workspace is released.`, {
      change: changeView(change),
    }),
  };
}

export function abandonError(
  caller: Caller,
  error: ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict | LeaseRequired,
): AbandonResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "LeaseStale":
      return leaseStale(caller, error);
    case "ChangeStateRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} was used for a different request.`,
          nextActions: [
            { kind: "call", title: "Abandon with a fresh Idempotency-Key", operationId: "abandon" },
          ],
        }),
      };
    case "LeaseRequired":
      return {
        status: 400,
        body: problem(400, "request.invalid", caller.requestId, {
          detail: `Only the holder of ${error.changeId}'s lease, or an operator, may abandon it.`,
          nextActions: [
            {
              kind: "call",
              title:
                "Abandon again with the keel-lease header: the lease declare or adopt answered",
              operationId: "abandon",
              args: { changeId: error.changeId },
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
  const { change, commitSha, remedy } = status;
  const state =
    change.parkReason === undefined ? change.state : `${change.state} (${change.parkReason})`;
  if (commitSha === null) {
    return {
      status: 404,
      body: problem(404, "resource.not_found", caller.requestId, {
        detail: `${change.id} has no submission yet; it is ${state}.`,
        nextActions:
          change.state === "parked"
            ? nextFor(change, remedy)
            : [
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
  const bounced = remedy === undefined ? "" : ` It bounced: ${remedy.reasons.join("; ")}.`;
  return {
    status: 200,
    body: envelope(
      `${change.id} is ${state} at ${commitSha.slice(0, 12)}.${bounced}`,
      submissionView(change, commitSha),
      nextFor(change, remedy),
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
        notices: page.notices.map(noticeView),
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

const ResolveFields = Schema.Struct({
  conflictId: ConflictId,
  changeId: ChangeId,
  lease: LeaseId,
  move: Move,
  note: Schema.optional(Schema.String),
});

export function resolveInput(input: Input<"resolve">): Result.Result<ResolveInput, Issues> {
  return Result.map(
    decodeWith(ResolveFields, {
      conflictId: input.conflictId,
      changeId: input.changeId,
      lease: input["keel-lease"],
      move: input.move,
      ...(input.note === undefined ? {} : { note: input.note }),
    }),
    (fields) => ({ ...fields, idempotencyKey: input["idempotency-key"] }),
  );
}

/** The conflict once a party's escalate has put it to a person, with what the agent does while it waits. */
export function resolveOk({ conflict }: ConflictView): ResolveResult {
  return {
    status: 200,
    body: envelope(
      `${conflict.id} is with a person${conflict.escalationId === undefined ? "" : ` as ${conflict.escalationId}`}. Keel tells you when it is ruled on.`,
      {
        conflict: {
          id: conflict.id,
          kind: conflict.kind,
          state: conflict.state,
          parties: [...conflict.parties],
          ...(conflict.subjectKey === undefined ? {} : { subject: conflict.subjectKey }),
          openedAt: iso(conflict.openedAt),
        },
      },
      [
        {
          kind: "read",
          title: "Read the question the person was asked",
          operationId: "Conflicts_getConflict",
          args: { conflictId: conflict.id },
        },
        {
          kind: "wait",
          title: "Wait for the ruling: it reaches your inbox as ConflictResolved",
          operationId: "inbox",
        },
      ],
    ),
  };
}

export function resolveError(
  caller: Caller,
  error: ChangeNotFound | LeaseStale | ConflictNotFound | MoveRefused | IdempotencyConflict,
): ResolveResult {
  switch (error._tag) {
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "LeaseStale":
      return leaseStale(caller, error);
    case "ConflictNotFound":
      return {
        status: 404,
        body: problem(404, "conflict.not_found", caller.requestId, {
          detail: `No conflict ${error.conflictId} in that project.`,
          nextActions: [
            {
              kind: "read",
              title: "List the project's conflicts",
              operationId: "Conflicts_listConflicts",
            },
          ],
        }),
      };
    case "MoveRefused":
      return {
        status: 409,
        body: problem(409, "conflict.move_refused", caller.requestId, {
          detail: `${error.conflictId}: ${error.reason}.`,
          nextActions: [
            {
              kind: "read",
              title: "Read the conflict for where it stands",
              operationId: "Conflicts_getConflict",
              args: { conflictId: error.conflictId },
            },
          ],
        }),
      };
    case "IdempotencyConflict":
      return reusedKey(caller, error, "resolve", "Resolve");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
