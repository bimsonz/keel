import { Context, type Effect, Schema } from "effect";
import { Proposition, SubjectKey } from "../../domain/coordination/index.ts";
import {
  ChangeId,
  ConflictId,
  type DecisionId,
  GuardId,
  ProjectId,
  SubjectId,
} from "../../domain/kernel/index.ts";
import { Decision, type DecisionNotFound } from "../../domain/memory/index.ts";
import type { ChangeView, ConflictRecord } from "./project-views.ts";

/**
 * A decision as Keel's memory holds it: the domain's `Decision` whole, with
 * the project it was ruled in and what its ruling settled. The conflict it
 * ruled, that conflict's subject and the parties it went against come from
 * the conflict; `holds` is what the ruling upheld of the conflict's two
 * propositions, and `guards` the guards admitted from the conflict's probe
 * that assert one of them, while they stand.
 */
export const IndexedDecision = Schema.Struct({
  decision: Decision,
  /** Its `D-n`, counted per project, as the feed labels it. */
  label: Schema.String,
  project: ProjectId,
  conflictId: Schema.optional(ConflictId),
  subjectId: Schema.optional(SubjectId),
  subjectKey: Schema.optional(SubjectKey),
  /** The propositions the ruling upheld: empty until the conflict's resolution is heard, and for a ruling that favoured no side. */
  holds: Schema.Array(Proposition),
  /** The parties the ruling went against, once the conflict's resolution is heard. */
  against: Schema.optional(Schema.Array(ChangeId)),
  guards: Schema.Array(GuardId),
});
export type IndexedDecision = typeof IndexedDecision.Type;

/** A guard and the decision it holds. */
export const GuardDecision = Schema.Struct({ guardId: GuardId, decision: IndexedDecision });
export type GuardDecision = typeof GuardDecision.Type;

export interface DecisionListRead {
  readonly project: ProjectId;
  /** Only the decisions on this subject. */
  readonly subject?: SubjectKey | undefined;
  /** The `nextCursor` of the page before; absent reads from the newest. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface DecisionListPage {
  /** Newest first. */
  readonly items: readonly IndexedDecision[];
  readonly nextCursor?: string | undefined;
}

/**
 * What `why` is asked about: a subject, or a file. A subject's anchors name a
 * file and no lines, so a line in the file narrows nothing; it is kept only to
 * say what was asked.
 */
export type WhyTarget =
  | { readonly kind: "subject"; readonly subject: SubjectKey }
  | { readonly kind: "path"; readonly path: string; readonly line?: number | undefined };

/** What one decision's chain is read from: the decision, its conflict as folded, and each change the conflict names, as folded. */
export interface WhySource {
  readonly decision: IndexedDecision;
  readonly conflict?: ConflictRecord | undefined;
  readonly changes: readonly ChangeView[];
}

/**
 * Keel's decisions, read from the Projector's index of the rulings' events
 * joined to the conflicts they ruled. Every state is read: a superseded or
 * overruled decision is still a decision, and the caller says what it scopes.
 */
export class Decisions extends Context.Service<
  Decisions,
  {
    readonly get: (decisionId: DecisionId) => Effect.Effect<IndexedDecision, DecisionNotFound>;
    readonly list: (read: DecisionListRead) => Effect.Effect<DecisionListPage>;
    /** The decision each of these guards holds; a guard that holds none is left out. */
    readonly ofGuards: (
      project: ProjectId,
      guardIds: readonly GuardId[],
    ) => Effect.Effect<readonly GuardDecision[]>;
    /** The project's decisions on any of these subjects, newest first. */
    readonly onSubjects: (
      project: ProjectId,
      subjects: readonly SubjectKey[],
    ) => Effect.Effect<readonly IndexedDecision[]>;
    /**
     * The project's decisions on the subjects anchored at this repository-relative
     * path, newest first, as `onSubjects` answers them. A subject's anchors are
     * those it was minted with, and name a file, never a line.
     */
    readonly atPath: (
      project: ProjectId,
      path: string,
    ) => Effect.Effect<readonly IndexedDecision[]>;
    /**
     * The project's active decisions on the subject, or on the subjects
     * anchored at the path, newest first, each with its conflict and every
     * change the conflict names (the premise's holder, the effect's change,
     * the parties), read at once: what `why` explains them by. What the
     * Projector has not folded is left out.
     */
    readonly explaining: (
      project: ProjectId,
      target: WhyTarget,
    ) => Effect.Effect<readonly WhySource[]>;
    /**
     * The changes that landed on the path most recently, newest first, each
     * as folded: under every path its last derivation said its diff touched.
     * What `why` explains a path by when no decision does. A landing whose
     * derivation kept no paths is not among them.
     */
    readonly landedOn: (project: ProjectId, path: string) => Effect.Effect<readonly ChangeView[]>;
  }
>()("keel/Decisions") {}
