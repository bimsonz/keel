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
  WorkspaceTokenInput,
} from "@keeltown/core/application/coordination";
import type { PushRejected } from "@keeltown/core/domain/integration";
import {
  type Change,
  type ChangeHeldByOther,
  type ChangeInOtherProject,
  type ChangeNotFound,
  type ChangeStateRefused,
  type CommitNotInWorkspace,
  FootprintEntry,
  type Lease,
  LEASE_TTL_MS,
  type LeaseNotLapsed,
  type LeaseStale,
  type NamespaceHalted,
  type PoolExhausted,
  type Preflight,
  MfpEffectProposition,
  MfpPremiseProposition,
  Move,
  type Proposition,
  type RevisionMismatch,
  type Untellable,
  type WireContext,
  effectOfMfp,
  effectToMfp,
  isAgentOwned,
  lapsesAt,
  leaseStands,
  premiseOfMfp,
  premiseToMfp,
  retractedBy,
  type WorkspaceNotFound,
} from "@keeltown/core/domain/coordination";
import type { IdempotencyConflict, InboxPage } from "@keeltown/core/domain/identity";
import type { ConflictNotFound, MoveRefused } from "@keeltown/core/domain/verification";
import {
  ChangeId,
  type NextAction as DomainNextAction,
  CommitSha,
  ConflictId,
  LeaseId,
  WorkspaceId,
} from "@keeltown/core/kernel";
import type {
  ConflictView,
  EditsRefused,
  ObjectNotFound,
  PackTooLarge,
  Remedy,
  SubmissionStatus,
  WorkspaceEdit,
  WorkspaceGrant,
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
  RefreshWorkspaceTokenResult,
  RelyResult,
  ResolveResult,
  ReviseResult,
  StatusResult,
  SubmitResult,
} from "../../../generated/http/app.gen.ts";
import { type NoticeView, noticeView } from "../notices.ts";
import type { AgentClaims, Caller } from "./caller.ts";
import { runView } from "./mappers.ts";
import { type NextAction, problem, type ProblemBody } from "./problems.ts";
import { PREMISE_EXAMPLE, PREMISE_HELP, premiseOfAgent } from "./premise-input.ts";

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

/** The operation a premise's place in a request belongs to, by the field it is under. */
const PREMISE_FIELDS: Readonly<Record<string, string>> = {
  premises: "declare",
  premisesAdded: "revise",
  premisesRetracted: "revise",
  premise: "rely",
};

/**
 * A request refused as malformed. One refused over a premise also says how to
 * write one, with a worked example as its next action, so an agent declares on
 * its next try.
 */
export function invalid(caller: Caller, issues: Issues) {
  const field = issues.map((issue) => String(issue.path[0] ?? "")).find((f) => f in PREMISE_FIELDS);
  const operationId = field === undefined ? undefined : PREMISE_FIELDS[field];
  return {
    status: 400 as const,
    body: problem(400, "request.invalid", caller.requestId, {
      issues,
      ...(operationId === undefined || field === undefined
        ? {}
        : {
            detail: PREMISE_HELP,
            nextActions: [
              {
                kind: "call" as const,
                title: `Call ${operationId} again with each premise written as this example`,
                operationId,
                args: { [field]: field === "premise" ? PREMISE_EXAMPLE : [PREMISE_EXAMPLE] },
              },
            ],
          }),
    }),
  };
}

type Path = readonly (string | number)[];

/**
 * An MFP 0.2 proposition held in Keel's form, or the issue that refuses it at
 * its field: one that does not read on its lattice, or holds what Keel cannot,
 * is refused with the reason, never repaired. An anchor with no commit means
 * the driver's working commit; where Keel knows none, `unpinned` says what to do.
 */
function holdAt(
  held: Result.Result<Proposition, Untellable>,
  path: Path,
  unpinned: string,
): Result.Result<Proposition, Issues> {
  return Result.mapError(held, (untellable) => [
    {
      path: [...path],
      message:
        untellable.reason === "anchor-commit"
          ? `${untellable.detail}: ${unpinned}`
          : `${untellable.detail} (${untellable.reason})`,
    },
  ]);
}

/** Each of a list held against what the edge knows, or every issue among them. */
const holding = <M>(
  values: readonly M[],
  path: Path,
  hold: (m: M, ctx: WireContext) => Result.Result<Proposition, Untellable>,
  ctx: WireContext,
  unpinned: string,
) => collect(values.map((m, i) => holdAt(hold(m, ctx), [...path, i], unpinned)));

/** Declare knows no working commit: the workspace is granted behind the edge. */
const ON_DECLARE =
  "an anchor on declare names its commit, as Keel has no working commit until the workspace is granted; name it, or add the premise with rely once declared, where an anchor with none means the change's base";

/** A change with no base has no working commit either. */
const NO_BASE =
  "the change has no base yet, so an anchor with no commit means nothing; name the commit";

/** Whether a 0.2 proposition anchors or cites code with no commit, which means the driver's working commit. */
const unpinned = (m: MfpPremiseProposition | MfpEffectProposition): boolean =>
  (m.anchors ?? []).some((a) => a.commit === undefined) ||
  (m.cites ?? []).some((c) => c.kind === "anchor" && c.commit === undefined);

const working = (base: CommitSha | undefined): WireContext =>
  base === undefined ? {} : { working: base };

/** Every issue among the results, in order. */
const failures = (...results: readonly (Result.Result<unknown, Issues> | undefined)[]): Issues =>
  results.flatMap((r) => (r !== undefined && Result.isFailure(r) ? r.failure : []));

/** Every result's value in order, or every issue among them. */
function collect<A>(results: readonly Result.Result<A, Issues>[]): Result.Result<A[], Issues> {
  const issues = results.flatMap((r) => (Result.isFailure(r) ? r.failure : []));
  return issues.length > 0
    ? Result.fail(issues)
    : Result.succeed(results.flatMap((r) => (Result.isSuccess(r) ? [r.success] : [])));
}

/** A premise as the API serves it: its strength written out, 0.2's default `must` where it gave none. */
export const served = (m: MfpPremiseProposition) => ({
  ...m,
  strength: m.strength ?? ("must" as const),
});

/**
 * Keel's stored propositions told in MFP 0.2, for one response. A stored one
 * with no 0.2 form (it does not read on its lattice, or holds what 0.2 cannot)
 * is left out of the view and shown in the response's notices instead, never
 * repaired.
 */
function teller() {
  const notices: NoticeView[] = [];
  const told = <A>(ref: string, p: Proposition, result: Result.Result<A, Untellable>): A[] => {
    if (Result.isSuccess(result)) return [result.success];
    notices.push({
      id: `untellable:${ref}:${notices.length}`,
      at: new Date().toISOString(),
      kind: "PropositionUntellable",
      title: `Proposition untellable in MFP 0.2: ${ref}`,
      detail: `Left out: ${p.subject} ${p.predicate} ${p.relation} ${String(p.value)}. ${result.failure.detail} (${result.failure.reason}).`,
      ref,
    });
    return [];
  };
  return {
    premise: (ref: string, p: Proposition) => told(ref, p, Result.map(premiseToMfp(p), served)),
    effect: (ref: string, p: Proposition) => told(ref, p, effectToMfp(p)),
    notices,
  };
}

type Teller = ReturnType<typeof teller>;

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
  premises: Schema.Array(MfpPremiseProposition),
  declaredEffects: Schema.optional(Schema.Array(MfpEffectProposition)),
});

export function declareInput(input: Input<"declare">): Result.Result<DeclareInput, Issues> {
  const fields = decodeWith(DeclareFields, {
    goal: input.goal,
    footprint: input.footprint ?? [],
    premises: (input.premises ?? []).map(premiseOfAgent),
    ...(input.declaredEffects === undefined ? {} : { declaredEffects: input.declaredEffects }),
  });
  const premises = Result.flatMap(fields, (f) =>
    holding(f.premises, ["premises"], premiseOfMfp, {}, ON_DECLARE),
  );
  const effects = Result.flatMap(fields, (f) =>
    holding(f.declaredEffects ?? [], ["declaredEffects"], effectOfMfp, {}, ON_DECLARE),
  );
  if (Result.isFailure(fields)) return Result.fail(fields.failure);
  if (Result.isFailure(premises) || Result.isFailure(effects))
    return Result.fail(failures(premises, effects));
  return Result.succeed({
    goal: fields.success.goal,
    footprint: fields.success.footprint,
    premises: premises.success,
    ...(fields.success.declaredEffects === undefined ? {} : { declaredEffects: effects.success }),
    idempotencyKey: input["idempotency-key"],
  });
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

function envelope<R>(
  summary: string,
  result: R,
  next: readonly NextAction[] = [],
  notices: readonly NoticeView[] = [],
) {
  return {
    ok: true,
    summary,
    result,
    findings: [],
    next: [...next],
    notices: [...notices],
    cost: {},
  };
}

/** A proposal as the API shows it: where it comes from, the commit it carries, who proposed it and what was approved. */
function proposalView(change: Change) {
  const { proposal, commitSha } = change;
  if (proposal === undefined || commitSha === undefined) return {};
  return {
    proposal: {
      fork: proposal.fork,
      commit: commitSha,
      proposer: proposal.proposer,
      ...(proposal.approved === undefined ? {} : { approved: proposal.approved }),
    },
  };
}

/** The lease an agent's change holds: one it declared, adopted or moves under its lease always has one. */
function leaseOf(change: Change): Lease {
  if (change.lease === undefined) throw new Error(`${change.id} holds no lease: no agent holds it`);
  return change.lease;
}

function changeView(change: Change, tell: Teller) {
  const ref = `change:${change.id}`;
  return {
    id: change.id,
    ...(change.agentId === undefined ? {} : { agentId: change.agentId }),
    origin: change.origin,
    ...proposalView(change),
    state: change.state,
    revision: change.intent.revision,
    goal: change.intent.goal,
    footprint: change.intent.footprint.map(footprintView),
    premises: change.intent.premises.flatMap((p) => tell.premise(ref, p)),
    ...(change.intent.declaredEffects === undefined
      ? {}
      : { declaredEffects: change.intent.declaredEffects.flatMap((p) => tell.effect(ref, p)) }),
    ...(change.commitSha === undefined ? {} : { commitSha: change.commitSha }),
    ...(change.run === undefined ? {} : { run: runView(change.run) }),
    createdAt: iso(change.createdAt),
  };
}

/** A workspace as the API hands it out: its token is shown once, here. */
function workspaceView(workspace: WorkspaceGrant) {
  return {
    id: workspace.workspaceId,
    remote: workspace.remote,
    token: workspace.token,
    expiresAt: iso(workspace.expiresAt),
    baseSha: workspace.baseSha,
  };
}

function leaseView(lease: Lease) {
  return {
    id: lease.id,
    renewedAt: iso(lease.renewedAt),
    lapsesAt: iso(lease.renewedAt + LEASE_TTL_MS),
  };
}

/**
 * A change's preflight as the API declares it. A contradiction whose side has
 * no 0.2 form is left out with a notice, and a move resting on one by its index
 * is told with the index it has in the list as served, or with no basis when
 * the one it rests on is left out.
 */
function preflightView(changeId: ChangeId, preflight: Preflight, tell: Teller) {
  const position = new Map<number, number>();
  const contradictions = preflight.contradictions.flatMap((c, i) => {
    const premise = tell.premise(`change:${changeId}`, c.premise);
    const other =
      c.withRole === "premise" ? tell.premise(c.holder, c.with) : tell.effect(c.holder, c.with);
    if (premise[0] === undefined || other[0] === undefined) return [];
    position.set(i, position.size);
    return [
      {
        premise: premise[0],
        with: other[0],
        holder: c.holder,
        ...(c.withRole === undefined ? {} : { withRole: c.withRole }),
      },
    ];
  });
  const rests = preflight.basis?._tag === "contradiction" ? preflight.basis.index : undefined;
  const index = rests === undefined ? undefined : position.get(rests);
  const basis =
    rests === undefined
      ? preflight.basis
      : index === undefined
        ? undefined
        : { _tag: "contradiction" as const, index };
  return {
    neighbours: preflight.neighbours.map((n) => ({ ...n, subjects: [...n.subjects] })),
    contradictions,
    precedents: preflight.precedents.map((p) => ({
      decisionId: p.decisionId,
      summary: p.summary,
      decidedAt: iso(p.decidedAt),
      ...(p.scope === undefined ? {} : { scope: p.scope }),
    })),
    suggestedMove: preflight.suggestedMove,
    ...(basis === undefined ? {} : { basis }),
    ...(preflight.alternatives === undefined ? {} : { alternatives: [...preflight.alternatives] }),
    ...(preflight.compared === undefined ? {} : { compared: { ...preflight.compared } }),
  };
}

/**
 * The wait that tells an agent its change landed. Unread notices first, so a
 * landing that came before the call is not missed.
 */
const landingOf: NextAction = {
  kind: "read",
  title: "Wait in your inbox for ChangeLanded: the change has landed only when it says so",
  operationId: "inbox",
  args: { wait: 600 },
};

/** The states Keel moves a submitted change through towards landing: an agent in them waits. */
const OPEN_STATES: ReadonlySet<string> = new Set([
  "submitted",
  "deriving",
  "drifted",
  "verifying",
  "queued",
  "integrating",
]);

/** What a summary says of a change that has not landed, so no agent reads "submitted" or "queued" as landed. */
const notLanded = (state: string) =>
  `It is ${state}, not landed: it has landed only when your inbox says ChangeLanded.`;

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

/**
 * What declare tells an agent whose change names no path: preflight finds a
 * change's neighbours through its footprint, so it saw none, and a revise that
 * names the paths lets it look.
 */
function unplaced(change: Change) {
  if (change.intent.footprint.length > 0) return { clause: "", next: [] };
  return {
    clause:
      " Its footprint is empty, so Keel cannot see which changes it would meet: revise it with the paths you will edit, create or delete.",
    next: [
      {
        kind: "call" as const,
        title:
          "Revise the change with the paths it will touch, so preflight can find its neighbours",
        operationId: "revise",
        args: {
          changeId: change.id,
          "keel-lease": leaseOf(change).id,
          "if-match": `"${change.intent.revision}"`,
        },
      },
    ],
  };
}

export function declareOk(declared: Declared): DeclareResult {
  const { change, preflight, workspace } = declared;
  const tell = teller();
  const footprint = unplaced(change);
  return {
    status: 201,
    body: envelope(
      `Declared ${change.id} (${change.state}). Push your commits to the workspace remote with its token, then submit.${footprint.clause}`,
      {
        change: changeView(change, tell),
        preflight: preflightView(change.id, preflight, tell),
        workspace: workspaceView(workspace),
        lease: leaseView(leaseOf(change)),
      },
      [
        ...footprint.next,
        {
          kind: "call",
          title: "Submit a commit once it is pushed to the workspace",
          operationId: "submit",
          args: { changeId: change.id },
        },
      ],
      tell.notices,
    ),
  };
}

export function declareError(
  caller: Caller,
  error: PoolExhausted | IdempotencyConflict | ChangeStateRefused,
): DeclareResult {
  switch (error._tag) {
    case "ChangeStateRefused":
      return {
        status: 409,
        body: problem(409, "change.state_refused", caller.requestId, {
          detail: `This Idempotency-Key's change ${error.changeId} is ${error.state}: it holds no workspace now. Read the change, or declare new work with a fresh Idempotency-Key.`,
          nextActions: [
            {
              kind: "read",
              title: "Read the change for how it ended",
              operationId: "change",
              args: { changeId: error.changeId },
            },
            { kind: "call", title: "Declare with a fresh Idempotency-Key", operationId: "declare" },
          ],
        }),
      };
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
      `Submitted ${commitSha.slice(0, 12)} for ${change.id}; Keel is verifying it. ${notLanded(change.state)}`,
      submissionView(change, commitSha),
      [landingOf, statusOf(change.id)],
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

/**
 * A call under a change's lease from another agent of its project, which can
 * read the change: it is told who holds it and when it may adopt it, never
 * that the change does not exist.
 */
export function heldByOther(caller: Pick<Caller, "requestId">, error: ChangeHeldByOther) {
  const holder = error.holderName ?? error.holder;
  return {
    status: 409 as const,
    body: problem(409, "change.held_by_other", caller.requestId, {
      detail:
        error.lapsesAt === undefined
          ? `${error.changeId} is held by ${holder}, and Keel holds it now: its lease cannot lapse until Keel hands it back. Only the agent holding a change acts under its lease.`
          : `${error.changeId} is held by ${holder} under a lease that lapses at ${iso(error.lapsesAt)} unless renewed; adopt it after that. Only the agent holding a change acts under its lease.`,
      nextActions: apiActions(error.nextActions),
    }),
  };
}

export function submitError(
  caller: Caller,
  error:
    | NamespaceHalted
    | ChangeHeldByOther
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | CommitNotInWorkspace
    | IdempotencyConflict,
): SubmitResult {
  switch (error._tag) {
    case "NamespaceHalted":
      return {
        status: 403,
        body: problem(403, "namespace.halted", caller.requestId, {
          detail: `Verification spend is stopped for ${error.namespace}, so it takes no submission: a verification there would run nothing and bounce the change.`,
          nextActions: apiActions(error.nextActions),
        }),
      };
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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
  const tell = teller();
  return {
    status: 200,
    body: envelope(
      `Rebased ${change.id} onto trunk ${base.slice(0, 12)}, now on your workspace's keel/trunk. Merge it, resolve, push, then submit.`,
      { change: changeView(change, tell), ref, base },
      [
        {
          kind: "call",
          title:
            "Run git fetch origin keel/trunk && git merge FETCH_HEAD, resolve any conflicts, push, then submit",
          operationId: "submit",
          args: { changeId: change.id },
        },
      ],
      tell.notices,
    ),
  };
}

export function rebaseError(
  caller: Caller,
  error:
    | ChangeHeldByOther
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | IdempotencyConflict
    | PushRejected
    | PackTooLarge,
): RebaseResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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
  const tell = teller();
  return {
    status: 200,
    body: envelope(
      `Committed ${commit.changed} path(s) to ${change.id}'s workspace as ${commit.commitSha.slice(0, 12)}. Submit it when the change is ready.`,
      {
        change: changeView(change, tell),
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
      tell.notices,
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
    | ChangeHeldByOther
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | IdempotencyConflict
    | CommitParentRefused
    | WorkspaceHeadMoved
    | EditsRefused
    | ObjectNotFound
    | PackTooLarge,
): CommitResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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
    case "IdempotencyConflict":
      return reusedKey(caller, error, "commit", "Commit");
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

const TokenFields = Schema.Struct({ workspaceId: WorkspaceId, lease: LeaseId });

/** The workspace and the lease: nothing is stored, so the Idempotency-Key is not used. */
export function refreshInput(
  input: Input<"refreshWorkspaceToken">,
): Result.Result<WorkspaceTokenInput, Issues> {
  return decodeWith(TokenFields, { workspaceId: input.workspaceId, lease: input["keel-lease"] });
}

/** The same workspace, as `declare` hands it out, with its fresh token. */
export function refreshedOk(workspace: WorkspaceGrant): RefreshWorkspaceTokenResult {
  return { status: 200, body: workspaceView(workspace) };
}

export function refreshError(
  caller: Caller,
  error: ChangeHeldByOther | WorkspaceNotFound | LeaseStale | ChangeStateRefused,
): RefreshWorkspaceTokenResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
    case "WorkspaceNotFound":
      return {
        status: 404,
        body: problem(404, "workspace.not_found", caller.requestId, {
          detail: `You hold no workspace ${error.workspaceId}.`,
          nextActions: [
            {
              kind: "call",
              title: "Declare a change for a workspace of your own",
              operationId: "declare",
            },
          ],
        }),
      };
    case "LeaseStale":
      return leaseStale(caller, error);
    case "ChangeStateRefused":
      return stateRefused(caller, error);
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
  premisesAdded: Schema.Array(MfpPremiseProposition),
  premisesRetracted: Schema.Array(MfpPremiseProposition),
  declaredEffects: Schema.optional(Schema.Array(MfpEffectProposition)),
});

/**
 * A revision as asked, its propositions as MFP 0.2 told them. They are held
 * against the change it revises (`revising`): an anchor with no commit means
 * the change's base, and a retraction names a premise the change stores.
 */
export interface ReviseRequest {
  readonly revise: Omit<ReviseInput, "premisesAdded" | "premisesRetracted" | "declaredEffects">;
  readonly added: readonly MfpPremiseProposition[];
  readonly retracted: readonly MfpPremiseProposition[];
  readonly effects?: readonly MfpEffectProposition[];
}

export function reviseInput(input: Input<"revise">): Result.Result<ReviseRequest, Issues> {
  const fields = decodeWith(ReviseFields, {
    changeId: input.changeId,
    lease: input["keel-lease"],
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.footprint === undefined ? {} : { footprint: input.footprint }),
    premisesAdded: (input.premisesAdded ?? []).map(premiseOfAgent),
    premisesRetracted: (input.premisesRetracted ?? []).map(premiseOfAgent),
    ...(input.declaredEffects === undefined ? {} : { declaredEffects: input.declaredEffects }),
  });
  const revision = ifMatchInput(input["if-match"]);
  if (Result.isFailure(fields) || Result.isFailure(revision))
    return Result.fail(failures(fields, revision));
  const { goal, footprint, premisesAdded, premisesRetracted, declaredEffects, ...rest } =
    fields.success;
  return Result.succeed({
    revise: {
      ...rest,
      ifMatchRevision: revision.success,
      ...(goal === undefined ? {} : { goal }),
      ...(footprint === undefined ? {} : { footprint }),
      idempotencyKey: input["idempotency-key"],
    },
    added: premisesAdded,
    retracted: premisesRetracted,
    ...(declaredEffects === undefined ? {} : { effects: declaredEffects }),
  });
}

/** Whether a revision is held against the change itself: to retract, or to hold an anchor with no commit at its base. */
export const revisesAgainstChange = (request: ReviseRequest): boolean =>
  request.retracted.length > 0 || [...request.added, ...(request.effects ?? [])].some(unpinned);

/**
 * Each retracted premise as the change stores it: the one whose 0.2 form is
 * the one retracted, so a premise stored in an older spelling is retracted by
 * echoing what Keel told. One that matches no stored premise retracts nothing,
 * as a retraction never did.
 */
export const retractions = (
  stored: readonly Proposition[],
  retracted: readonly MfpPremiseProposition[],
  ctx: WireContext = {},
): Proposition[] =>
  retracted.flatMap((m) => {
    const premise = retractedBy(stored, m, ctx);
    return premise === undefined ? [] : [premise];
  });

/** The revision held against the change it revises: its base, and the premises it stores. */
export function revising(
  base: CommitSha | undefined,
  stored: readonly Proposition[],
  request: ReviseRequest,
): Result.Result<ReviseInput, Issues> {
  const ctx = working(base);
  const added = holding(request.added, ["premisesAdded"], premiseOfMfp, ctx, NO_BASE);
  const effects = holding(request.effects ?? [], ["declaredEffects"], effectOfMfp, ctx, NO_BASE);
  if (Result.isFailure(added) || Result.isFailure(effects))
    return Result.fail(failures(added, effects));
  return Result.succeed({
    ...request.revise,
    premisesAdded: added.success,
    premisesRetracted: retractions(stored, request.retracted, ctx),
    ...(request.effects === undefined ? {} : { declaredEffects: effects.success }),
  });
}

/** What a revision or a rely leaves: the change at its new revision, and the preflight of its intent now. */
function revisedBody(verb: string, revised: Revised) {
  const { change, preflight } = revised;
  const tell = teller();
  const found = preflight.contradictions.length;
  return envelope(
    `${verb} ${change.id}, now at revision ${change.intent.revision}.` +
      (found === 0
        ? ""
        : ` Preflight found ${found} contradiction${found === 1 ? "" : "s"} with another change: refine before you build on it.`),
    { change: changeView(change, tell), preflight: preflightView(change.id, preflight, tell) },
    [
      {
        kind: "call",
        title: "Submit a commit once it is pushed to the workspace",
        operationId: "submit",
        args: { changeId: change.id },
      },
    ],
    tell.notices,
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
  error:
    | ChangeHeldByOther
    | ChangeNotFound
    | LeaseStale
    | RevisionMismatch
    | ChangeStateRefused
    | IdempotencyConflict,
): ReviseResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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

const RelyFields = Schema.Struct({
  changeId: ChangeId,
  lease: LeaseId,
  premise: MfpPremiseProposition,
});

/** A rely as asked, its premise as MFP 0.2 told it, held against the change (`relying`). */
export interface RelyRequest {
  readonly rely: Omit<RelyInput, "premise">;
  readonly premise: MfpPremiseProposition;
}

export function relyInput(input: Input<"rely">): Result.Result<RelyRequest, Issues> {
  return Result.map(
    decodeWith(RelyFields, {
      changeId: input.changeId,
      lease: input["keel-lease"],
      premise: premiseOfAgent(input.premise),
    }),
    ({ premise, ...fields }) => ({
      rely: { ...fields, idempotencyKey: input["idempotency-key"] },
      premise,
    }),
  );
}

/** Whether a rely is held against the change itself: to hold an anchor with no commit at its base. */
export const reliesAgainstChange = (request: RelyRequest): boolean => unpinned(request.premise);

/** The rely held against the change's base: an anchor with no commit means it. */
export function relying(
  base: CommitSha | undefined,
  request: RelyRequest,
): Result.Result<RelyInput, Issues> {
  return Result.map(
    holdAt(premiseOfMfp(request.premise, working(base)), ["premise"], NO_BASE),
    (premise) => ({ ...request.rely, premise }),
  );
}

export function relyOk(relied: Revised): RelyResult {
  return { status: 200, body: revisedBody("Added the premise to", relied) };
}

export function relyError(
  caller: Caller,
  error: ChangeHeldByOther | ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict,
): RelyResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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

/**
 * A change read by id: the change itself, bare, as the spec's `Change`. The
 * agent holding its lease, under the change's run when it has one, reads the
 * lease too, so a lease it lost track of can be read back.
 */
/** A change as the API shows it, bare, to a reader who holds no lease on it. */
export const changeBody = (change: Change) => changeView(change, teller());

export function changeOk(change: Change, reader?: AgentClaims): ChangeResult {
  const view = changeView(change, teller());
  return {
    status: 200,
    body: holdsLease(change, reader) ? { ...view, lease: heldLeaseView(change) } : view,
  };
}

/** Whether `reader` is the agent holding the change's lease, under the change's run when it has one. */
function holdsLease(change: Change, reader: AgentClaims | undefined): boolean {
  return (
    reader !== undefined &&
    leaseStands(change) &&
    reader.agentId === change.lease?.agentId &&
    (change.run === undefined || change.run.id === reader.run?.id)
  );
}

/** The lease as its holder reads it, with no lapse time while the platform holds the change. */
function heldLeaseView(change: Change) {
  const lease = leaseOf(change);
  return {
    id: lease.id,
    renewedAt: iso(lease.renewedAt),
    ...(isAgentOwned(change.state) ? { lapsesAt: iso(lapsesAt(lease)) } : {}),
  };
}

export function changeReadError(caller: Caller, error: ChangeNotFound): ChangeResult {
  return changeNotFound(caller, error);
}

export function nearbyOk(changeId: ChangeId, preflight: Preflight): NearbyResult {
  const found = preflight.contradictions.length;
  const tell = teller();
  return {
    status: 200,
    body: envelope(
      `${preflight.neighbours.length} change${preflight.neighbours.length === 1 ? "" : "s"} near ${changeId}, ${found} contradiction${found === 1 ? "" : "s"}.`,
      { preflight: preflightView(changeId, preflight, tell) },
      [],
      tell.notices,
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
  const tell = teller();
  return {
    status: 200,
    body: envelope(
      `Adopted ${change.id} (${change.state}) under a new lease. Pull its workspace, carry on, then submit.`,
      {
        change: changeView(change, tell),
        lease: leaseView(leaseOf(change)),
        ...(workspace === undefined ? {} : { workspace: workspaceView(workspace) }),
      },
      [statusOf(change.id)],
      tell.notices,
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
          detail:
            error.lapsesAt === undefined
              ? `Keel holds ${error.changeId} now, and its lease cannot lapse until Keel hands it back to its agent.`
              : `${error.changeId}'s lease lapses at ${iso(error.lapsesAt)}; it can be adopted after that.`,
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
  const tell = teller();
  return {
    status: 200,
    body: envelope(
      `Withdrew ${change.id}; its workspace is released.`,
      { change: changeView(change, tell) },
      [],
      tell.notices,
    ),
  };
}

export function abandonError(
  caller: Caller,
  error:
    | ChangeHeldByOther
    | ChangeNotFound
    | LeaseStale
    | ChangeStateRefused
    | IdempotencyConflict
    | LeaseRequired,
): AbandonResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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
  const landed = change.state === "landed";
  const waiting = !landed && remedy === undefined && OPEN_STATES.has(change.state);
  return {
    status: 200,
    body: envelope(
      landed
        ? `${change.id} has landed at ${commitSha.slice(0, 12)}.`
        : `${change.id} is ${state} at ${commitSha.slice(0, 12)}, not landed.${bounced}${waiting ? " It has landed only when your inbox says ChangeLanded." : ""}`,
      submissionView(change, commitSha),
      waiting ? [landingOf, ...nextFor(change, remedy)].slice(0, 3) : nextFor(change, remedy),
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
          title: "Keep waiting: call inbox again with this cursor",
          operationId: "inbox",
          args: { cursor: page.cursor, wait: 600 },
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

/** A move as the doorway takes it: `distinguish` needs its `note`, the distinction, and the schema cannot say so. */
export function resolveInput(input: Input<"resolve">): Result.Result<ResolveInput, Issues> {
  return Result.flatMap(
    decodeWith(ResolveFields, {
      conflictId: input.conflictId,
      changeId: input.changeId,
      lease: input["keel-lease"],
      move: input.move,
      ...(input.note === undefined ? {} : { note: input.note }),
    }),
    ({ move, note, ...fields }): Result.Result<ResolveInput, Issues> => {
      const idempotencyKey = input["idempotency-key"];
      if (move === "escalate") return Result.succeed({ ...fields, move, note, idempotencyKey });
      if (note === undefined || note.trim() === "")
        return Result.fail([
          {
            path: ["body", "note"],
            message: "distinguish needs a note: why the decision does not govern this change",
          },
        ]);
      return Result.succeed({ ...fields, move, note, idempotencyKey });
    },
  );
}

/** A distinction recorded on the change: the guard that holds the decision still runs on it. */
export function distinguishedOk({ conflict }: ConflictView, changeId: ChangeId): ResolveResult {
  const decisionId = conflict.decisionId;
  return {
    status: 200,
    body: envelope(
      `${changeId} is distinguished from ${decisionId ?? "the decision"}, which resolved ${conflict.id}. A guard that holds that decision still runs on the change: only a person's ruling ends a decision.`,
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
      decisionId === undefined
        ? []
        : [
            {
              kind: "read",
              title: "Read the decision the change is distinguished from",
              operationId: "Memory_getDecision",
              args: { decisionId },
            },
          ],
    ),
  };
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
  error:
    | ChangeHeldByOther
    | ChangeNotFound
    | LeaseStale
    | ConflictNotFound
    | MoveRefused
    | IdempotencyConflict,
): ResolveResult {
  switch (error._tag) {
    case "ChangeHeldByOther":
      return heldByOther(caller, error);
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
