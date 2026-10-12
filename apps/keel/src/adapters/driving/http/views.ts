import type { ProbeSource } from "@keeltown/core/application/coordination";
import {
  type ConflictSide,
  isOpenConflict,
  matrixOf,
  sidesOf,
} from "@keeltown/core/application/memory";
import type { ChangeState, Proposition } from "@keeltown/core/domain/coordination";
import type { ConflictState } from "@keeltown/core/domain/verification";
import { ChangeId, ProjectId } from "@keeltown/core/kernel";
import type {
  ChangeListPage,
  ChangeSummary,
  ConflictListPage,
  ConflictRecord,
  ViewSnapshot,
} from "@keeltown/core/ports";
import { Result } from "effect";
import type {
  Changes_listChangesResult,
  Conflicts_getConflictResult,
  Conflicts_listConflictsResult,
  Inbox_getSnapshotResult,
  Probes_getProbeSourceResult,
} from "../../../generated/http/app.gen.ts";
import { problem, type ProblemBody } from "./problems.ts";
import { apiActions, type Input } from "./work-loop.ts";

/**
 * Pure mappers for Mission Control's views of a project: `GET /v1/changes`
 * (the change list), `GET /v1/events/snapshot` (the snapshot at the head) and
 * `GET /v1/conflicts` with `GET /v1/conflicts/{id}` (its conflicts).
 */

type Issues = NonNullable<ProblemBody["issues"]>;

const iso = (ms: number) => new Date(ms).toISOString();

/** A change list cursor: the `#n` a page's `nextCursor` named. */
const NUMBER = /^[1-9]\d{0,8}$/;

export interface ChangeListInput {
  readonly state?: ChangeState;
  readonly project?: ProjectId;
  readonly cursor?: number;
  readonly limit?: number;
}

/** The query, with a cursor that is not a page's `nextCursor` refused as a 400 naming it. */
export function changeListInput(
  input: Input<"Changes_listChanges">,
): Result.Result<ChangeListInput, Issues> {
  if (input.cursor !== undefined && !NUMBER.test(input.cursor)) {
    return Result.fail([
      { path: ["cursor"], message: "Expected a cursor from an earlier page: a change number" },
    ]);
  }
  return Result.succeed({
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.project === undefined ? {} : { project: ProjectId.make(input.project) }),
    ...(input.cursor === undefined ? {} : { cursor: Number(input.cursor) }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

const summaryBody = (summary: ChangeSummary) => ({
  changeId: summary.changeId,
  number: summary.number,
  state: summary.state,
  ...(summary.parkReason === undefined ? {} : { parkReason: summary.parkReason }),
  agentId: summary.agentId,
  goal: summary.goal,
  revision: summary.revision,
  declaredAt: iso(summary.declaredAt),
  updatedAt: iso(summary.updatedAt),
});

export function changesOk(page: ChangeListPage): Changes_listChangesResult {
  return {
    status: 200,
    body: {
      items: page.items.map(summaryBody),
      ...(page.nextCursor === undefined ? {} : { nextCursor: String(page.nextCursor) }),
    },
  };
}

export function snapshotOk(snapshot: ViewSnapshot): Inbox_getSnapshotResult {
  return {
    status: 200,
    body: {
      cursor: snapshot.cursor,
      changes: snapshot.changes.map(summaryBody),
      ...(snapshot.trunk === undefined ? {} : { trunk: snapshot.trunk }),
    },
  };
}

/** The list's filters and page. The project is the one the policy decided the read on, never the query's. */
export interface ConflictListInput {
  readonly open?: boolean;
  readonly changeId?: ChangeId;
  readonly state?: ConflictState;
  readonly cursor?: number;
  readonly limit?: number;
}

/** The query, with a cursor that is not a page's `nextCursor` refused as a 400 naming it. */
export function conflictListInput(
  input: Input<"Conflicts_listConflicts">,
): Result.Result<ConflictListInput, Issues> {
  if (input.cursor !== undefined && !NUMBER.test(input.cursor)) {
    return Result.fail([
      { path: ["cursor"], message: "Expected a cursor from an earlier page: a conflict number" },
    ]);
  }
  return Result.succeed({
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.changeId === undefined ? {} : { changeId: ChangeId.make(input.changeId) }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.cursor === undefined ? {} : { cursor: Number(input.cursor) }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

const labelled = (label: string | undefined) => (label === undefined ? {} : { label });

/** What a conflict's list row and its own page both say of it. */
function conflictHead({ conflict, labels }: ConflictRecord) {
  return {
    id: conflict.id,
    kind: conflict.kind,
    state: conflict.state,
    parties: [...conflict.parties],
    ...(conflict.subjectKey === undefined ? {} : { subject: conflict.subjectKey }),
    openedAt: iso(conflict.openedAt),
    label: labels.conflict,
    ...(conflict.predicate === undefined ? {} : { predicate: conflict.predicate }),
  };
}

const probeRef = ({ probe, labels }: ConflictRecord) =>
  probe === undefined
    ? {}
    : { probe: { id: probe.id, ...labelled(labels.probe), state: probe.state } };

const guardRef = ({ guard, labels }: ConflictRecord) =>
  guard === undefined ? {} : { guard: { id: guard.id, ...labelled(labels.guard) } };

const escalationRef = ({ conflict, labels }: ConflictRecord) =>
  conflict.escalationId === undefined
    ? {}
    : {
        escalation: {
          id: conflict.escalationId,
          ...labelled(labels.escalation),
          open: isOpenConflict(conflict.state),
        },
      };

const decisionRef = ({ conflict, labels }: ConflictRecord) =>
  conflict.decisionId === undefined
    ? {}
    : { decision: { id: conflict.decisionId, ...labelled(labels.decision) } };

const conflictRow = (record: ConflictRecord) => ({
  ...conflictHead(record),
  ...probeRef(record),
  ...guardRef(record),
  ...escalationRef(record),
  ...decisionRef(record),
});

export function conflictsOk(page: ConflictListPage): Conflicts_listConflictsResult {
  return {
    status: 200,
    body: {
      items: page.items.map(conflictRow),
      ...(page.nextCursor === undefined ? {} : { nextCursor: String(page.nextCursor) }),
      totals: page.totals,
    },
  };
}

const anchorBody = (anchor: NonNullable<Proposition["anchors"]>[number]) => ({
  path: anchor.path,
  ...(anchor.symbol === undefined ? {} : { symbol: anchor.symbol }),
  commit: anchor.commit,
});

/** A side's proposition in the shape ConflictSuspected carries it on the feed (`EventProposition`). */
const eventProposition = (proposition: Proposition) => ({
  subject: proposition.subject,
  predicate: proposition.predicate,
  relation: proposition.relation,
  value: proposition.value,
  ...(proposition.unit === undefined ? {} : { unit: proposition.unit }),
  ...(proposition.scope === undefined ? {} : { scope: proposition.scope }),
  ...(proposition.anchors === undefined ? {} : { anchors: proposition.anchors.map(anchorBody) }),
  ...(proposition.gloss === undefined ? {} : { gloss: proposition.gloss }),
  ...(proposition.strength === undefined ? {} : { strength: proposition.strength }),
  ...(proposition.cites === undefined
    ? {}
    : {
        cites: proposition.cites.map((cite) =>
          cite._tag === "anchor"
            ? { _tag: cite._tag, anchor: anchorBody(cite.anchor) }
            : { ...cite },
        ),
      }),
});

const sideBody = (side: ConflictSide) => ({
  changeId: side.changeId,
  role: side.role,
  proposition: eventProposition(side.proposition),
  ...(side.told === undefined
    ? {}
    : {
        told: {
          how: side.told.how,
          nextActions: apiActions(side.told.nextActions),
          at: iso(side.told.at),
        },
      }),
});

export function conflictOk(record: ConflictRecord): Conflicts_getConflictResult {
  const { conflict, probe, guard, labels } = record;
  const sides = sidesOf(record);
  return {
    status: 200,
    body: {
      ...conflictHead(record),
      ...(conflict.origin === undefined ? {} : { origin: conflict.origin }),
      ...(record.settledAt === undefined ? {} : { settledAt: iso(record.settledAt) }),
      ...(record.proven === undefined ? {} : { proven: record.proven }),
      ...(record.dismissed === undefined ? {} : { dismissed: record.dismissed }),
      ...(sides === undefined
        ? {}
        : { sides: { holder: sideBody(sides.holder), other: sideBody(sides.other) } }),
      matrix: matrixOf(record).map((row) => ({
        world: row.world,
        probe: row.probe.map((run) => ({
          run: run.run,
          outcome: run.outcome,
          resultRef: run.resultRef,
          at: iso(run.at),
        })),
        checks: row.checks.map((check) => ({
          check: check.check,
          run: check.run,
          outcome: check.outcome,
          ...(check.counts === undefined ? {} : { counts: check.counts }),
          ...(check.reason === undefined ? {} : { reason: check.reason }),
          at: iso(check.at),
        })),
      })),
      ...(probe === undefined
        ? {}
        : {
            probe: {
              id: probe.id,
              ...labelled(labels.probe),
              state: probe.state,
              ...(probe.attempts === undefined ? {} : { attempts: probe.attempts }),
              ...(probe.bundleHash === undefined ? {} : { bundleHash: probe.bundleHash }),
              ...(probe.discarded === undefined
                ? {}
                : {
                    discarded: {
                      reason: probe.discarded,
                      ...(record.draftFailure === undefined ? {} : { detail: record.draftFailure }),
                    },
                  }),
            },
          }),
      ...(guard === undefined
        ? {}
        : {
            guard: {
              id: guard.id,
              ...labelled(labels.guard),
              state: guard.retiredAt === undefined ? ("admitted" as const) : ("retired" as const),
              admittedAt: iso(guard.admittedAt),
              probeId: guard.probeId,
              runs: guard.runs,
            },
          }),
      ...(conflict.escalationId === undefined
        ? {}
        : {
            escalation: {
              id: conflict.escalationId,
              ...labelled(labels.escalation),
              open: isOpenConflict(conflict.state),
              ...(record.escalated === undefined ? {} : { reason: record.escalated }),
            },
          }),
      ...decisionRef(record),
      ...(conflict.move === undefined ? {} : { move: conflict.move }),
    },
  };
}

/**
 * A conflict that is not in the project, with the way forward. The policy
 * answers a conflict of a project the caller may not see with this too
 * (`refusalResult`), so a missing conflict, a private project and an unknown
 * one read alike.
 */
export function conflictNotFound(
  caller: { readonly requestId: string },
  error: { readonly conflictId: string },
) {
  return {
    status: 404 as const,
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
}

/** A probe's source as the API serves it. */
export function probeSourceOk(source: ProbeSource): Probes_getProbeSourceResult {
  return {
    status: 200,
    body: {
      probeId: source.probeId,
      ...(source.bundleHash === undefined ? {} : { bundleHash: source.bundleHash }),
      files: source.files.map(({ path, text }) => ({ path, text })),
    },
  };
}

/**
 * A probe that is not in the project, with the way forward. The policy
 * answers a probe of a project the caller may not see with this too
 * (`refusalResult`), so a missing probe, a private project and an unknown one
 * read alike.
 */
export function probeNotFound(
  caller: { readonly requestId: string },
  error: { readonly probeId: string },
) {
  return {
    status: 404 as const,
    body: problem(404, "probe.not_found", caller.requestId, {
      detail: `No probe ${error.probeId} in that project.`,
      nextActions: [
        {
          kind: "read",
          title: "List the project's conflicts, each with its probe",
          operationId: "Conflicts_listConflicts",
        },
      ],
    }),
  };
}
