import { Context, type Effect } from "effect";
import type { SubjectKey } from "../../domain/coordination/index.ts";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type { ConflictId, ContentHash, ProbeId, ProjectId } from "../../domain/kernel/index.ts";
import type {
  DraftFailure,
  Conflict,
  ConflictNotFound,
  ConflictStateRefused,
  Probe,
  ProbeNotFound,
  ProbeOutcome,
  ProbeStateRefused,
  World,
} from "../../domain/verification/index.ts";

/** The Subject DO a conflict lives on: `subj:<projectId>:<key>`. */
export interface SubjectRef {
  readonly projectId: ProjectId;
  readonly key: SubjectKey;
}

/** A conflict, and the probe drafted for it when there is one. */
export interface ConflictView {
  readonly conflict: Conflict;
  readonly probe?: Probe | undefined;
}

export interface DraftedProbe {
  readonly conflictId: ConflictId;
  /** 1–3: the drafts it took. */
  readonly attempts: number;
  readonly bundleHash: ContentHash;
}

export interface FailedDraft {
  readonly conflictId: ConflictId;
  readonly attempts: number;
  /** Why the drafting ended without a probe to calibrate, as ProbeDiscarded carries it. */
  readonly reason: DraftFailure;
}

export interface ProbeCell {
  readonly conflictId: ConflictId;
  readonly probeId: ProbeId;
  readonly world: World;
  readonly run: number;
  readonly outcome: ProbeOutcome;
  readonly resultRef: string;
}

export interface WorldCheckCell {
  readonly conflictId: ConflictId;
  readonly world: World;
  /** `suite:<changeId>`: the party whose suite ran. */
  readonly check: string;
  readonly run: number;
  readonly outcome: ProbeOutcome;
  readonly counts?:
    | { readonly passed: number; readonly failed: number; readonly skipped: number }
    | undefined;
  readonly reason?: string | undefined;
}

export type LedgerRefusal =
  | ConflictNotFound
  | ConflictStateRefused
  | ProbeNotFound
  | ProbeStateRefused
  | IdempotencyConflict;

/**
 * A conflict and its probe, hosted by the Subject DO of the conflict's
 * subject: what the Probe Workflow reports its facts to. Every fact goes
 * through the domain's conflict and probe machines, which fence it, and each
 * is idempotent per (conflict or probe, world, run).
 */
export class ProbeLedger extends Context.Service<
  ProbeLedger,
  {
    /** The conflict as it stands, with its probe. */
    readonly conflict: (
      at: SubjectRef,
      conflictId: ConflictId,
    ) => Effect.Effect<ConflictView, ConflictNotFound>;
    /** A probe was drafted for the suspected conflict, which starts probing it. Once per conflict. */
    readonly probeDrafted: (
      at: SubjectRef,
      drafted: DraftedProbe,
    ) => Effect.Effect<ConflictView, LedgerRefusal>;
    /** Drafting ended without a probe: the probe is discarded as draft-failed. Once per conflict. */
    readonly probeDraftFailed: (
      at: SubjectRef,
      failed: FailedDraft,
    ) => Effect.Effect<ConflictView, LedgerRefusal>;
    /** One world-matrix cell of the conflict's probe. */
    readonly probeCellRan: (
      at: SubjectRef,
      cell: ProbeCell,
    ) => Effect.Effect<ConflictView, LedgerRefusal>;
    /** One check of a party's suite in one world while the conflict is probing. */
    readonly worldCheckRan: (
      at: SubjectRef,
      cell: WorldCheckCell,
    ) => Effect.Effect<ConflictView, LedgerRefusal>;
  }
>()("keel/ProbeLedger") {}
